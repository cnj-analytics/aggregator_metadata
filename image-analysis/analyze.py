"""
Menu image analysis. Three copies of this run side by side for one menu request (SHARD 0, 1, 2), started by
Supabase as soon as a restaurant is opened in the dashboard.

  1. load the models, then report 'ready'
  2. radar_img_job(ticket, shard)   -> waits until the menu has been read, then returns this machine's third of the images
  3. score each image on its own (no comparison with the rest of the menu)
  4. radar_img_progress(...)        -> progress for the loading bar; also tells the machine to stop if the restaurant was closed
  5. radar_img_finish(...)          -> this machine's per-item results (Supabase merges the three)

Nothing is written anywhere except the request row, and logs only show counts (this repository is public).
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICKET, SHARD, SHARDS
"""
import io, os, re, sys, math, time, json, traceback
import numpy as np, requests
from PIL import Image, ImageOps

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
TICKET = os.environ.get('TICKET', '')
SHARD = int(os.environ.get('SHARD', '0') or 0)
SHARDS = int(os.environ.get('SHARDS', '3') or 3)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
SIZE = 512
METHOD_VERSION = 'v2'
MENU_WAIT = 180   # seconds a warmed-up machine waits for the menu before giving up


def rpc(name, payload, attempts=3):
    for a in range(attempts):
        try:
            r = requests.post(f'{SUPABASE_URL}/rest/v1/rpc/{name}', json=payload, timeout=30,
                              headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}', 'Content-Type': 'application/json'})
            if r.ok:
                return r.json() if r.text else None
            if r.status_code < 500:
                raise RuntimeError(f'{name} http {r.status_code}')
        except requests.RequestException:
            pass
        time.sleep(2 * (a + 1))
    raise RuntimeError(f'{name} failed')


def image_url(u):
    return u.replace('{w}', str(SIZE)).replace('{h}', str(SIZE)).replace('{&quality}', '')


def fetch(url):
    r = requests.get(image_url(url), headers={'User-Agent': UA, 'Accept': 'image/*'}, timeout=20)
    r.raise_for_status()
    im = Image.open(io.BytesIO(r.content))
    im = ImageOps.exif_transpose(im).convert('RGB')
    return im




# ---------------------------------------------------------------- measured checks (plain maths)
def measured(im):
    import cv2
    w, h = im.size
    a = np.asarray(im).astype(np.float32)
    g = cv2.cvtColor(a.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    lab = cv2.cvtColor(a.astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
    L = lab[..., 0] * 100 / 255
    # sharpness: variance of the Laplacian, mapped to 0-100 on a log scale (~20 = soft, ~1000+ = crisp)
    lv = float(cv2.Laplacian(g, cv2.CV_32F).var())
    sharp = max(0.0, min(100.0, (math.log10(lv + 1) - 1.3) / (3.2 - 1.3) * 100))
    # exposure
    bright = float(L.mean())
    clip_hi = float((L > 97).mean() * 100)
    clip_lo = float((L < 3).mean() * 100)
    contrast = float(L.std())
    # colourfulness (Hasler & Süsstrunk 2003)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    rg, yb = R - G, 0.5 * (R + G) - B
    colourful = float(math.hypot(rg.std(), yb.std()) + 0.3 * math.hypot(rg.mean(), yb.mean()))
    # warmth: mean b* (yellow-blue) in LAB, >0 warm
    warmth = float(lab[..., 2].mean() - 128)
    # noise: robust sigma of the fine-detail residual (median absolute deviation)
    resid = g - cv2.GaussianBlur(g, (3, 3), 0)
    noise = float(np.median(np.abs(resid - np.median(resid))) * 1.4826)
    # background & subject: estimate background colour from the border, then how much of the frame differs from it
    bw = max(4, int(min(w, h) * 0.06))
    border = np.concatenate([a[:bw].reshape(-1, 3), a[-bw:].reshape(-1, 3), a[:, :bw].reshape(-1, 3), a[:, -bw:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    border_spread = float(np.median(np.abs(border - bg)))
    diff = np.abs(a - bg).mean(axis=2)
    mask = diff > 28
    fill = float(mask.mean() * 100)
    ys, xs = np.where(mask)
    if len(xs) > 50:
        cx, cy = xs.mean() / w, ys.mean() / h
        bbox = ((xs.max() - xs.min()) * (ys.max() - ys.min())) / (w * h) * 100
        touches = int(xs.min() <= 1) + int(ys.min() <= 1) + int(xs.max() >= w - 2) + int(ys.max() >= h - 2)
    else:
        cx = cy = 0.5; bbox = 0.0; touches = 0
    edges = cv2.Canny(g.astype(np.uint8), 80, 160) > 0
    border_edges = float(np.concatenate([edges[:bw].ravel(), edges[-bw:].ravel(), edges[:, :bw].ravel(), edges[:, -bw:].ravel()]).mean() * 100)
    plain_bg = border_spread < 10 and border_edges < 2
    white_bg = plain_bg and float(bg.mean()) > 225
    # placeholder / near-blank: very little variation overall
    q = (a // 32).astype(np.int32)
    codes = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    top_share = float(np.bincount(codes.ravel()).max() / codes.size * 100)
    blank = contrast < 3.5 or (top_share > 88 and contrast < 12)
    # blown highlights only count on the food itself: pure-white areas joined to the image edge are a
    # deliberate white backdrop, not lost detail, so they are left out
    hi = (L > 97).astype(np.uint8)
    if hi.any():
        n, lab_ = cv2.connectedComponents(hi, connectivity=8)
        edge_ids = np.unique(np.concatenate([lab_[0], lab_[-1], lab_[:, 0], lab_[:, -1]]))
        inner = hi.astype(bool) & ~np.isin(lab_, edge_ids[edge_ids > 0])
        subject = ~(np.isin(lab_, edge_ids[edge_ids > 0]))
        clip_hi = float(inner.sum() / max(1, subject.sum()) * 100)
    return dict(w=w, h=h, sharpness=round(sharp, 1), laplacian_var=round(lv, 1), brightness=round(bright, 1), clip_hi=round(clip_hi, 2),
                clip_lo=round(clip_lo, 2), contrast=round(contrast, 1), colourfulness=round(colourful, 1), warmth=round(warmth, 1),
                noise=round(noise, 2), fill=round(fill, 1), bbox=round(bbox, 1), centre=[round(cx, 2), round(cy, 2)], touches_edges=touches,
                plain_bg=bool(plain_bg), white_bg=bool(white_bg), busy_bg=bool(border_edges > 8), blank=bool(blank))




# ---------------------------------------------------------------- learned models
class Models:
    def __init__(self):
        import torch, open_clip, pyiqa
        torch.set_num_threads(max(1, os.cpu_count() or 2))
        self.torch = torch
        self.clip, _, self.pre = open_clip.create_model_and_transforms('ViT-L-14', pretrained='openai', cache_dir='/models/clip')
        self.clip.eval()
        self.tok = open_clip.get_tokenizer('ViT-L-14')
        self.aes = torch.nn.Sequential(
            torch.nn.Linear(768, 1024), torch.nn.Dropout(0.2), torch.nn.Linear(1024, 128), torch.nn.Dropout(0.2),
            torch.nn.Linear(128, 64), torch.nn.Dropout(0.1), torch.nn.Linear(64, 16), torch.nn.Linear(16, 1))
        sd = torch.load('/models/laion_aesthetic_l14.pth', map_location='cpu')
        sd = {k.replace('layers.', ''): v for k, v in sd.items()}
        self.aes.load_state_dict(sd); self.aes.eval()
        self.topiq = pyiqa.create_metric('topiq_nr', device=torch.device('cpu'))
        self.prompt_cache = {}
        for p in PROMPT_SETS:          # encode all prompts once, while waiting for the menu
            self.text(p)

    def text(self, prompts):
        key = tuple(prompts)
        if key not in self.prompt_cache:
            with self.torch.no_grad():
                t = self.clip.encode_text(self.tok(list(prompts)))
                self.prompt_cache[key] = t / t.norm(dim=-1, keepdim=True)
        return self.prompt_cache[key]

    def score(self, im):
        torch = self.torch
        with torch.no_grad():
            e = self.clip.encode_image(self.pre(im).unsqueeze(0))
            e = e / e.norm(dim=-1, keepdim=True)
            aesthetic = float(self.aes(e.float())[0, 0])
            t = torch.from_numpy(np.asarray(im.resize((384, 384))).astype(np.float32) / 255).permute(2, 0, 1).unsqueeze(0)
            technical = float(self.topiq(t)) * 100
        return e, dict(aesthetic=round(aesthetic, 2), technical=round(technical, 1))

    def probs(self, e, prompts):
        t = self.text(prompts)
        p = (100.0 * (e @ t.T)[0]).softmax(dim=-1).tolist()
        return {k: round(v * 100, 1) for k, v in zip(prompts, p)}


KIND = {'plated': 'a plated dish of food on a plate or in a bowl',
        'unplated': 'food served without a plate, such as a pizza, burger, sandwich or wrap',
        'glass': 'a drink served in a glass or cup',
        'can': 'a canned or bottled soft drink or bottle of water',
        'packaged': 'a packaged product in a jar, box or wrapper with a printed label',
        'merch': 'merchandise such as a t-shirt, cap, mug or tote bag'}
CONTENT = {'food': 'a photo of food', 'drink': 'a photo of a drink', 'logo': 'a logo or brand graphic',
           'text': 'text, a menu or a price list', 'person': 'a photo of a person'}
STYLE = ['a professional studio product photograph', 'an amateur smartphone snapshot']
SHOT = {'overhead': 'an overhead top-down shot of food', '45-degree': 'a 45-degree angle shot of food on a table',
        'close-up': 'a close-up shot of food', 'side-on': 'a side-on shot of food'}
SCENE = {'plain': 'food on a plain seamless background', 'table': 'food on a restaurant table or kitchen counter',
         'styled': 'food styled with props and ingredients around it'}
OVERLAY = ['a photo with text or a logo printed over it', 'a clean photo with no text on it']
PROMPT_SETS = [list(KIND.values()), list(CONTENT.values()), STYLE, list(SHOT.values()), list(SCENE.values()), OVERLAY]


def pick(model, e, d):
    p = model.probs(e, list(d.values()))
    out = {k: p[v] for k, v in d.items()}
    k = max(out, key=out.get)
    return k, out[k], out


# ---------------------------------------------------------------- what kind of item is it? (name/category first, image second)
def rx(words):
    return re.compile(r'(?<![a-z])(' + '|'.join(words) + r')(?![a-z])')

MERCH_RX = rx([r'merch', r'merchandise', r't-?shirts?', r'tee', r'hoodies?', r'sweatshirts?', r'tote', r'caps?', r'hats?', r'keychains?',
               r'stickers?', r'gift ?cards?', r'vouchers?', r'aprons?', r'socks'])
BRAND_RX = rx([r'coca[- ]?cola', r'coke', r'pepsi', r'7[- ]?up', r'sprite', r'fanta', r'mirinda', r'mountain dew', r'dr\.? pepper', r'schweppes',
               r'red ?bull', r'monster energy', r'vimto', r'perrier', r's\.? ?pellegrino', r'san pellegrino', r'evian', r'acqua panna', r'masafi',
               r'al ain', r'arwa', r'aquafina', r'voss', r'lipton', r'snapple', r'capri[- ]?sun', r'rubicon', r'barbican',
               r'lays', r'pringles', r'doritos', r'kit ?kat', r'snickers', r'twix'])
GENERIC_PACKAGED_RX = rx([r'soft drinks?', r'fizzy drinks?', r'canned', r'cans?', r'bottled', r'mineral water', r'sparkling water', r'still water',
                          r'water', r'\d+(\.\d+)? ?(ml|l|cl)'])
DRINK_RX = rx([r'smoothies?', r'juices?', r'coffee', r'lattes?', r'cappuccinos?', r'espresso', r'americano', r'flat white', r'cortado', r'macchiato',
               r'mochas?', r'teas?', r'chai', r'karak', r'milkshakes?', r'shakes?', r'frapp[eé]s?', r'frappuccinos?', r'lemonades?', r'mojitos?',
               r'mocktails?', r'lassi', r'hot chocolate', r'cold brew', r'slush(ies|y)?', r'boba', r'bubble tea', r'iced', r'drinks?', r'beverages?'])
FOOD_RX = rx([r'cakes?', r'cookies?', r'brownies?', r'croissants?', r'sandwich(es)?', r'bowls?', r'puddings?', r'cheesecakes?', r'tiramisu',
               r'pancakes?', r'waffles?', r'bars?', r'muffins?', r'donuts?', r'doughnuts?', r'ice cream'])


def classify(it, e, model):
    name = (it.get('name') or '').lower()
    cat = (it.get('category') or '').lower()
    both = name + ' | ' + cat
    kind_img, conf, _ = pick(model, e, KIND) if model else (None, 0, {})
    if MERCH_RX.search(both) and not FOOD_RX.search(name):
        return 'merch', kind_img
    food_word = FOOD_RX.search(both)          # e.g. 'Mocha Miss-U' in a cakes category is a cake, not a coffee
    if BRAND_RX.search(name):
        return 'packaged', kind_img
    if DRINK_RX.search(name) and not food_word:
        return 'drink', kind_img
    if GENERIC_PACKAGED_RX.search(name) or (GENERIC_PACKAGED_RX.search(cat) and not food_word):
        return 'packaged', kind_img
    if kind_img == 'merch' and conf >= 60:
        return 'merch', kind_img
    if kind_img in ('can', 'packaged') and conf >= 55:
        return 'packaged', kind_img
    if DRINK_RX.search(cat) and not food_word:
        return 'drink', kind_img
    if kind_img == 'glass' and conf >= 50:
        return 'drink', kind_img
    return 'dish', kind_img

KIND_LABEL = {'dish': 'Dish', 'drink': 'Drink made here', 'packaged': 'Packaged product', 'merch': 'Merchandise'}


# ---------------------------------------------------------------- feedback rules (each photo judged on its own)
def feedback(r):
    fix, tip, good = [], [], []
    m, s, kind = r['measured'], r.get('scores') or {}, r['kind']
    food = kind in ('dish', 'drink')
    if m['blank']:
        fix.append('Looks like a placeholder or near-blank image, not a real photo of the item.')
        return dict(fix=fix, tip=tip, good=good)
    # content: only food and drinks made here are expected to show the item itself (packaging, labels and logos are fine elsewhere)
    if food and r.get('content_top') in ('logo', 'text', 'person') and r.get('content_conf', 0) >= 60:
        what = {'logo': 'a logo or brand graphic', 'text': 'text or a menu', 'person': 'a person'}[r['content_top']]
        fix.append(f'The photo mainly shows {what}, not the {"dish" if kind == "dish" else "drink"}.')
    # sharpness
    if m['sharpness'] < 25:
        fix.append('Blurry: edges are not crisp. Use a sharper original or reshoot with the focus on the item.')
    elif m['sharpness'] < 40:
        tip.append('Slightly soft; a sharper original would help.')
    elif m['sharpness'] > 70:
        good.append('Crisp detail.')
    # size
    if m['w'] < 400 or m['h'] < 400:
        fix.append(f'Low resolution ({m["w"]}×{m["h"]} px); it will look pixelated on large phones.')
    # exposure (absolute thresholds, not compared with other photos)
    if m['brightness'] < 28:
        fix.append('Too dark: the item is hard to see. Brighten it or reshoot in more light.')
    elif m['brightness'] < 38:
        tip.append('A little dark; brightening would help.')
    elif m['brightness'] > 90 and not m['white_bg']:
        tip.append('Washed out / very bright overall.')
    hi_limit = 12 if food else 25
    if m['clip_hi'] > hi_limit:
        (fix if food else tip).append(f'Blown-out highlights: {m["clip_hi"]:.0f}% of the {"food" if food else "product"} is pure white with no detail.')
    if 45 <= m['brightness'] <= 85 and m['clip_hi'] <= 5 and m['clip_lo'] <= 5:
        good.append('Well lit.')
    if s and s.get('technical', 100) < 35:
        tip.append('Low technical quality (heavy compression or a small original).')
    if kind == 'dish':
        if m['contrast'] < 10:
            tip.append('Flat, low-contrast look; a little more contrast would make the dish pop.')
        if m['colourfulness'] < 15:
            tip.append('Muted colours; the dish looks dull.')
        elif m['colourfulness'] > 45:
            good.append('Vivid colour.')
        if m['fill'] < 15:
            tip.append(f'The dish is small in the frame (about {m["fill"]:.0f}%); crop tighter.')
        elif r.get('plated') and m['touches_edges'] >= 3 and m['fill'] > 85:
            tip.append('The plate is cut off on several sides; leave a little space around it.')
        if m['busy_bg'] and r.get('scene') != 'styled':
            tip.append('Busy background competes with the dish.')
        if r.get('overlay', 0) >= 80:
            tip.append('Text or a logo appears over the photo; a clean food photo usually works better.')
    elif kind == 'drink':
        if m['fill'] < 10:
            tip.append('The drink is small in the frame; crop tighter.')
    else:
        if m['fill'] < 10:
            tip.append('The product is small in the frame; crop tighter.')
        if m['busy_bg']:
            tip.append('The product would stand out more on a plain background.')
    if m['plain_bg']:
        good.append('Clean white background.' if m['white_bg'] else 'Clean, uncluttered background.')
    if s and food:
        if s['aesthetic'] >= 6:
            good.append('Strong overall visual appeal.')
        elif s['aesthetic'] < 4.3:
            tip.append('Low visual appeal; styling, light or angle could be improved.')
    return dict(fix=fix, tip=tip, good=good)


def grade(r):
    """0-100. A decent delivery-app photo lands around 65-80 (B). Weights are shown in the report's 'How we assess'."""
    m, s = r['measured'], r.get('scores') or {}
    if m['blank']:
        return 5
    aes = max(0, min(100, (s['aesthetic'] - 3.5) / 3 * 100)) if s else None
    tech = max(0, min(100, s['technical'])) if s else None
    expo = max(0, 100 - min(100, max(0, 40 - m['brightness']) * 3 + max(0, m['brightness'] - 88) * 3 + m['clip_hi'] * 2))
    if r['kind'] in ('dish', 'drink'):
        parts = [(0.40, tech), (0.35, aes), (0.15, m['sharpness']), (0.10, expo)]
    else:
        parts = [(0.50, tech), (0.15, aes), (0.20, m['sharpness']), (0.15, expo)]
    parts = [(w, v) for w, v in parts if v is not None]
    base = sum(w * v for w, v in parts) / sum(w for w, _ in parts)
    g = 30 + 0.7 * base
    if r['kind'] in ('dish', 'drink') and r.get('content_top') in ('logo', 'text', 'person') and r.get('content_conf', 0) >= 60:
        g -= 20
    if m['w'] < 400 or m['h'] < 400:
        g -= 8
    # blur, darkness and blown highlights are already in the score; each one that needs fixing costs a little more
    g -= 6 * sum(1 for f in (r.get('feedback') or {}).get('fix', []) if f.startswith(('Blurry', 'Too dark', 'Blown')))
    return int(round(max(0, min(100, g))))


# ---------------------------------------------------------------- run
def progress(done, total, stage):
    try:
        return rpc('radar_img_progress', {'p_ticket': int(TICKET), 'p_shard': SHARD, 'p_done': done, 'p_total': total, 'p_stage': stage})
    except Exception:
        return 'running'


def finish(items, error=None):
    rpc('radar_img_finish', {'p_ticket': int(TICKET), 'p_shard': SHARD, 'p_items': items, 'p_error': error})


def score_item(it, models):
    r = dict(id=it['id'], ord=it.get('ord'), name=it['name'], category=it.get('category'), price=it.get('price'), popular=it.get('popular'))
    im = fetch(it['img'])
    m = measured(im)
    r['measured'] = m
    e = None
    if models:
        e, r['scores'] = models.score(im)
        r['content_top'], r['content_conf'], _ = pick(models, e, CONTENT)
        r['studio'] = list(models.probs(e, STYLE).values())[0]
        r['overlay'] = list(models.probs(e, OVERLAY).values())[0]
    r['kind'], kind_img = classify(it, e, models)
    r['kind_label'] = KIND_LABEL[r['kind']]
    r['plated'] = kind_img == 'plated'
    if models and r['kind'] == 'dish':
        r['shot'] = pick(models, e, SHOT)[0]
        r['scene'] = pick(models, e, SCENE)[0]
    r['feedback'] = feedback(r)
    r['grade'] = grade(r)
    return r


def main():
    t0 = time.time()
    if progress(0, None, 'loading') in ('cancelled', 'gone'):
        print('stopped before start'); return
    try:
        models = Models()
    except Exception:
        traceback.print_exc(limit=1)
        models = None
    print(f'models loaded in {round(time.time() - t0)}s')
    if progress(0, None, 'ready') in ('cancelled', 'gone'):
        print('stopped: restaurant closed'); return
    waited = time.time()
    while True:
        job = rpc('radar_img_job', {'p_ticket': int(TICKET), 'p_shard': SHARD, 'p_shards': SHARDS})
        st = (job or {}).get('status')
        if st == 'ok':
            break
        if st in ('cancelled', 'gone'):
            print(f'stopped: {st}'); return
        if time.time() - waited > MENU_WAIT:
            finish(None, 'no_menu'); print('stopped: menu never arrived'); return
        time.sleep(2)
    items = job['items']
    total = len(items)
    print(f'shard {SHARD}: {total} images')
    progress(0, total, 'scoring')
    results = []
    for k, it in enumerate(items):
        try:
            results.append(score_item(it, models))
        except Exception as ex:
            results.append(dict(id=it['id'], ord=it.get('ord'), name=it['name'], category=it.get('category'), error=type(ex).__name__))
        if progress(k + 1, total, 'scoring') in ('cancelled', 'gone'):
            print('stopped: restaurant closed'); return
    finish(results)
    print(f'done: {sum(1 for r in results if "grade" in r)} scored, {sum(1 for r in results if "error" in r)} failed, {round(time.time() - t0)}s')


if __name__ == '__main__':
    if not (SUPABASE_URL and SUPABASE_KEY and TICKET):
        sys.exit('missing env')
    try:
        main()
    except Exception as ex:
        traceback.print_exc(limit=2)
        try:
            finish(None, type(ex).__name__)
        except Exception:
            pass
        sys.exit(1)
