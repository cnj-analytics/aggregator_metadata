"""
Menu image analysis (scoring v3, calibrated to the owner's own grades of 30 real menu photos). Three copies of this run side by side for one menu request (SHARD 0, 1, 2), started by
Supabase as soon as a restaurant is opened in the dashboard.

  1. load the models, then report 'ready'
  2. radar_img_job(ticket, shard)   -> waits until the menu has been read, then returns this machine's third of the images
  3. score each image on its own (no comparison with the rest of the menu)
  4. radar_img_progress(...)        -> progress for the loading bar; also tells the machine to stop if the restaurant was closed
  5. radar_img_finish(...)          -> this machine's per-item results (Supabase merges the three)

Nothing is written anywhere except the request row, and logs only show counts (this repository is public).
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICKET, SHARD, SHARDS, MODE (menu | calib)
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
METHOD_VERSION = 'v3'
MODE = os.environ.get('MODE', 'menu') or 'menu'
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




# ---------------------------------------------------------------- measured checks (plain maths on the pixels)
def measured(im):
    import cv2
    w, h = im.size
    a = np.asarray(im).astype(np.float32)
    u8 = a.astype(np.uint8)
    g = cv2.cvtColor(u8, cv2.COLOR_RGB2GRAY).astype(np.float32)
    lab = cv2.cvtColor(u8, cv2.COLOR_RGB2LAB).astype(np.float32)
    L = lab[..., 0] * 100 / 255
    A_, B_ = lab[..., 1] - 128, lab[..., 2] - 128
    # --- background (from the border) and the subject (what differs from it)
    bw = max(4, int(min(w, h) * 0.06))
    border = np.concatenate([a[:bw].reshape(-1, 3), a[-bw:].reshape(-1, 3), a[:, :bw].reshape(-1, 3), a[:, -bw:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    border_spread = float(np.median(np.abs(border - bg)))
    edges = cv2.Canny(u8 if u8.ndim == 2 else g.astype(np.uint8), 80, 160) > 0
    border_edges = float(np.concatenate([edges[:bw].ravel(), edges[-bw:].ravel(), edges[:, :bw].ravel(), edges[:, -bw:].ravel()]).mean() * 100)
    plain_bg = border_spread < 10 and border_edges < 2
    bg_lab = cv2.cvtColor(bg.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)[0, 0]
    bg_L, bg_chroma = float(bg_lab[0] * 100 / 255), float(math.hypot(bg_lab[1] - 128, bg_lab[2] - 128))
    white_bg = plain_bg and bg_L > 88 and bg_chroma < 12
    neutral_bg = bg_chroma < 12            # white, grey, beige, black backdrops
    diff = np.abs(a - bg).mean(axis=2)
    mask = diff > 28
    fill = float(mask.mean() * 100)
    if not plain_bg or mask.mean() < 0.03:     # in-scene photo: treat the centre of the frame as the subject
        mask = np.zeros_like(mask); mask[int(h * .2):int(h * .8), int(w * .2):int(w * .8)] = True
    ys, xs = np.where(mask)
    touches = int(xs.min() <= 1) + int(ys.min() <= 1) + int(xs.max() >= w - 2) + int(ys.max() >= h - 2) if len(xs) else 0
    bbox = float(((xs.max() - xs.min()) * (ys.max() - ys.min())) / (w * h) * 100) if len(xs) else 0.0
    # --- sharpness on the subject itself (edge strength), and how much fine detail really exists
    lap = cv2.Laplacian(g, cv2.CV_32F)
    lv_all = float(lap.var()); lv_sub = float(lap[mask].var()) if mask.any() else lv_all
    s100 = lambda v: max(0.0, min(100.0, (math.log10(v + 1) - 1.3) / (3.2 - 1.3) * 100))
    # a photo stretched up from a small original loses almost nothing when shrunk and enlarged again
    small = cv2.resize(g, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    back = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    detail = float(np.abs(g - back)[mask].mean()) if mask.any() else float(np.abs(g - back).mean())
    # --- exposure, including uneven light (a dark corner and a washed-out corner in the same photo)
    Ls = L[mask] if mask.any() else L.ravel()
    bright = float(Ls.mean()); contrast = float(Ls.std())
    dark_share = float((Ls < 18).mean() * 100); blown_share = float((Ls > 96).mean() * 100)
    qs = [float(L[:h // 2, :w // 2].mean()), float(L[:h // 2, w // 2:].mean()), float(L[h // 2:, :w // 2].mean()), float(L[h // 2:, w // 2:].mean())]
    uneven = max(qs) - min(qs)
    # --- colour: how lively the subject is, and how well it stands out from the background
    R, G, B = a[..., 0][mask], a[..., 1][mask], a[..., 2][mask]
    rg, yb = R - G, 0.5 * (R + G) - B
    colourful = float(math.hypot(rg.std(), yb.std()) + 0.3 * math.hypot(rg.mean(), yb.mean())) if mask.any() else 0.0
    sub_lab = np.array([L[mask].mean(), A_[mask].mean(), B_[mask].mean()]) if mask.any() else np.array([bright, 0, 0])
    bg_vec = np.array([bg_L, bg_lab[1] - 128, bg_lab[2] - 128])
    separation = float(np.linalg.norm(sub_lab - bg_vec))       # CIE76 colour distance subject vs background
    sub_chroma = float(np.hypot(A_[mask], B_[mask]).mean()) if mask.any() else 0.0
    # --- placeholder / near-blank
    q = (u8 // 32).astype(np.int32); codes = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    top_share = float(np.bincount(codes.ravel()).max() / codes.size * 100)
    blank = float(L.std()) < 3.5 or (top_share > 88 and float(L.std()) < 12)
    r1 = lambda v: round(float(v), 1)
    return dict(w=w, h=h, sharp_all=r1(s100(lv_all)), sharpness=r1(s100(lv_sub)), detail=round(detail, 2),
                brightness=r1(bright), contrast=r1(contrast), dark_share=r1(dark_share), blown_share=r1(blown_share), uneven=r1(uneven),
                colourfulness=r1(colourful), sub_chroma=r1(sub_chroma), separation=r1(separation), bg_L=r1(bg_L), bg_chroma=r1(bg_chroma),
                fill=r1(fill), bbox=r1(bbox), touches_edges=touches, plain_bg=bool(plain_bg), white_bg=bool(white_bg),
                neutral_bg=bool(neutral_bg), busy_bg=bool(border_edges > 8), blank=bool(blank))


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

    def sim(self, e, prompts):
        return [round(float(x), 4) for x in (e @ self.text(prompts).T)[0].tolist()]


KIND = {'plated': 'a plated dish of food on a plate or in a bowl',
        'unplated': 'food served without a plate, such as a pizza, burger, sandwich or wrap',
        'glass': 'a drink served in a glass or cup',
        'can': 'a canned or bottled soft drink or bottle of water',
        'packaged': 'a packaged product in a jar, box or wrapper with a printed label',
        'merch': 'merchandise or a non-food product such as candles, a t-shirt, cap, mug or tote bag'}
CONTENT = {'food': 'a photo showing food', 'drink': 'a photo showing a drink', 'product': 'a photo showing a packaged product',
           'logo': 'a logo or brand graphic only', 'text': 'text or a menu only', 'person': 'a photo of a person'}
# yes/no pairs: the first prompt is the "yes"
PAIRS = {
    'sharp': ['a sharp, in-focus, crisp photo', 'a blurry, out-of-focus, soft photo'],
    'hires': ['a high-resolution, detailed photo', 'a low-resolution, pixelated, heavily compressed photo'],
    'appetising': ['an appetizing, delicious-looking, mouth-watering photo', 'an unappetizing, dull, unappealing photo'],
    'pro': ['a professional, high-end commercial product photograph', 'a poor amateur snapshot'],
    'styled': ['a beautifully styled photo with a designed, colourful background and props', 'a plain photo on an empty white or grey background'],
    'separation': ['the subject stands out clearly from the background', 'the subject blends into a background of similar colour'],
    'real': ['a real photograph', 'an AI-generated, fake-looking or badly photoshopped composite image'],
    'lit': ['a well-lit, evenly exposed photo', 'a badly lit photo with dark shadows or blown-out bright areas'],
    'whole': ['the whole product is visible in the frame', 'a cropped close-up where only part of the product is visible'],
    'overlay': ['a photo with text or a logo printed over it', 'a clean photo with no text on it'],
}
PROMPT_SETS = [list(KIND.values()), list(CONTENT.values())] + list(PAIRS.values())


def pick(model, e, d):
    p = model.probs(e, list(d.values()))
    out = {k: p[v] for k, v in d.items()}
    k = max(out, key=out.get)
    return k, out[k], out


# ---------------------------------------------------------------- what kind of item is it? (name/category first, image second)
def rx(words):
    return re.compile(r'(?<![a-z])(' + '|'.join(words) + r')(?![a-z])')

MERCH_RX = rx([r'merch', r'merchandise', r't-?shirts?', r'tee', r'hoodies?', r'sweatshirts?', r'tote', r'caps?', r'hats?', r'keychains?',
               r'stickers?', r'gift ?cards?', r'vouchers?', r'aprons?', r'socks', r'candles?', r'balloons?', r'cake toppers?', r'party hats?'])
BRAND_RX = rx([r'coca[- ]?cola', r'coke', r'pepsi', r'7[- ]?up', r'sprite', r'fanta', r'mirinda', r'mountain dew', r'dr\.? pepper', r'schweppes',
               r'red ?bull', r'monster energy', r'vimto', r'perrier', r's\.? ?pellegrino', r'san pellegrino', r'evian', r'acqua panna', r'masafi',
               r'al ain', r'arwa', r'aquafina', r'voss', r'lipton', r'snapple', r'capri[- ]?sun', r'rubicon', r'barbican',
               r'lays', r'pringles', r'doritos', r'kit ?kat', r'snickers', r'twix', r'mogu ?mogu', r'alokozay', r'oreo', r'nutella', r'kinder'])
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


# ---------------------------------------------------------------- scoring (tuned on the owner's 30 graded photos)
# Four parts, appeal first: appeal 45%, clarity 25%, presentation 20%, light 10%. Hard problems then cap the grade.
P = dict(
    w_appeal=.45, w_clarity=.25, w_pres=.20, w_light=.10,
    # blur / softness
    sharp_lo=38, sharp_hi=70, detail_lo=2.2, detail_hi=5.0, clip_sharp_lo=35, clip_hires_lo=35,
    cap_soft_pixel=40, cap_soft_pixel_appetising=60, cap_blur=69,
    # background and separation
    white_bg_pen=10, neutral_pen=4, cap_white=89, sep_lo=18, sep_hi=45, sep_pen=12, busy_pen=6,
    # framing
    small_fill=12, small_pen=10, crop_pen=8,
    # light
    dark_cap=50, dark_bright=20, washed_bright=93,
    # content
    cap_not_visible=35,
    # bands
    excellent=90, good=70, needs_work=45)

LABELS = [('excellent', 'Excellent'), ('good', 'Good'), ('needs_work', 'Needs work'), ('replace', 'Replace')]


def lin(v, lo, hi):
    return max(0.0, min(100.0, (v - lo) / ((hi - lo) or 1) * 100))


def label_for(g, p=P):
    return 'excellent' if g >= p['excellent'] else 'good' if g >= p['good'] else 'needs_work' if g >= p['needs_work'] else 'replace'


def assess(r, p=P):
    """Turns the measurements into a grade, a label and a fix list. r = one photo's measurements."""
    m, s, y, kind = r['measured'], r.get('scores') or {}, r.get('pairs') or {}, r['kind']
    fix, tip, good = [], [], []
    if m['blank']:
        return dict(grade=5, label='replace', fix=['Looks like a placeholder or blank image, not a real photo of the item. Add a real photo.'], tip=[], good=[], parts={})
    food = kind in ('dish', 'drink')
    # --- clarity: subject sharpness, real fine detail, the quality model and the AI's sharp/blurry judgement
    sharp_part = lin(m['sharpness'], p['sharp_lo'] - 20, p['sharp_hi'])
    detail_part = lin(m['detail'], p['detail_lo'] - 1, p['detail_hi'])
    clarity = .30 * sharp_part + .25 * detail_part + .25 * s.get('technical', 60) + .20 * y.get('sharp', 60)
    blurry = (m['sharpness'] < p['sharp_lo'] and y.get('sharp', 50) < 60) or y.get('sharp', 100) < p['clip_sharp_lo']
    pixelated = m['detail'] < p['detail_lo'] or y.get('hires', 100) < p['clip_hires_lo']
    # --- appeal: visual appeal model + "appetising" (food) or "professional product photo" (products)
    aes = lin(s.get('aesthetic', 5), 3.5, 6.5)
    want = y.get('appetising', 50) if food else y.get('pro', 50)
    appeal = .55 * aes + .45 * want
    # --- presentation: background, separation, framing, styling
    pres = 55 + .45 * y.get('styled', 50)
    if m['white_bg']:
        pres -= p['white_bg_pen'] * 2; tip.append('Plain white background looks flat on a delivery app; a styled, coloured background would lift it.')
    elif m['neutral_bg'] and m['plain_bg']:
        pres -= p['neutral_pen'] * 2; tip.append('Neutral, plain background; more colour or styling behind the product would help.')
    sep = m['separation']
    if sep < p['sep_lo'] or y.get('separation', 50) < 35:
        pres -= p['sep_pen']; fix.append('The product blends into the background (similar colours, little contrast). Use a contrasting background or plate so it stands out.')
    if m['busy_bg'] and y.get('styled', 50) < 50:
        pres -= p['busy_pen']; tip.append('Busy, cluttered background competes with the product.')
    if m['plain_bg'] and m['fill'] < p['small_fill']:
        pres -= p['small_pen']; tip.append('The product is small in the frame; crop tighter so it is the hero.')
    if y.get('whole', 60) < 30 and kind in ('packaged', 'merch'):
        pres -= p['crop_pen']; tip.append('Too close: the whole item is not visible. Show the full product.')
    elif m['touches_edges'] >= 3 and m['plain_bg'] and m['fill'] > 85:
        pres -= p['crop_pen'] / 2; tip.append('The product is cut off at the edges; leave a little space around it.')
    pres = max(0.0, min(100.0, pres))
    # --- light
    light = 100 - max(0.0, p['dark_bright'] + 25 - m['brightness']) * 2.5 - max(0.0, m['brightness'] - (p['washed_bright'] - 8)) * 3 \
        - max(0.0, m['uneven'] - 25) * 1.2 - (100 - y.get('lit', 60)) * .25
    light = max(0.0, min(100.0, light))
    g = p['w_appeal'] * appeal + p['w_clarity'] * clarity + p['w_pres'] * pres + p['w_light'] * light
    # --- hard problems cap the grade
    caps = []
    visible = r.get('content_top') in ('food', 'drink', 'product') or r.get('content_conf', 0) < 50
    if not visible:
        caps.append(p['cap_not_visible']); fix.append('The photo shows only a logo, text or packaging art, not the product itself. Show the item.')
    if blurry and pixelated:
        # still recognisable and appetising (the owner's jalapeño-poppers rule): Needs work, not Replace
        c = p['cap_soft_pixel_appetising'] if (want >= 70 and aes >= 45) else p['cap_soft_pixel']
        caps.append(c); fix.append('Blurry and pixelated: the original photo is too small or out of focus. Replace it with a sharp, higher-resolution photo.')
    elif blurry:
        caps.append(p['cap_blur']); fix.append('Blurry: the subject is not in focus. Use a sharper photo.')
    elif pixelated:
        caps.append(p['cap_blur']); fix.append('Low resolution: the photo looks pixelated on large phones. Upload a larger original.')
    if m['brightness'] < p['dark_bright'] or m['dark_share'] > 45:
        caps.append(p['dark_cap']); fix.append('Very dark: the item is hard to see. Brighten it or reshoot in better light.')
    elif m['brightness'] > p['washed_bright'] and not m['white_bg']:
        caps.append(p['dark_cap']); fix.append('Very washed out: colours and detail are lost. Reduce the exposure.')
    elif light < 60:
        tip.append('Uneven light: dark shadows in one part and very bright areas in another.' if m['uneven'] > 25 else 'The light could be better; brighten or balance it.')
    if m['white_bg'] or (m['neutral_bg'] and m['plain_bg']):
        caps.append(p['cap_white'])
    if y.get('real', 100) < 25:
        tip.append('May look artificial or composited (lighting of product and background do not match).')
    if y.get('overlay', 0) >= 85:
        tip.append('Text or a logo is printed over the photo.')
    if caps:
        g = min(g, min(caps))
    g = int(round(max(0, min(100, g))))
    # --- what is working
    if not blurry and not pixelated and clarity >= 65: good.append('Sharp and clear.')
    if want >= 70 and food: good.append('Looks appetising.')
    if y.get('styled', 0) >= 60 and not m['white_bg']: good.append('Nicely styled.')
    if light >= 80: good.append('Well lit.')
    if sep >= p['sep_hi']: good.append('Stands out well from the background.')
    return dict(grade=g, label=label_for(g, p), fix=fix, tip=tip, good=good,
                parts=dict(appeal=round(appeal), clarity=round(clarity), presentation=round(pres), light=round(light)))


# ---------------------------------------------------------------- run
def progress(done, total, stage):
    try:
        return rpc('radar_img_progress', {'p_ticket': int(TICKET), 'p_shard': SHARD, 'p_done': done, 'p_total': total, 'p_stage': stage})
    except Exception:
        return 'running'


def finish(items, error=None):
    rpc('radar_img_finish', {'p_ticket': int(TICKET), 'p_shard': SHARD, 'p_items': items, 'p_error': error})


def measure_item(it, models):
    """Everything the scoring needs for one photo (raw numbers; the calibration run stores exactly this)."""
    r = dict(id=it['id'], ord=it.get('ord'), name=it['name'], category=it.get('category'), price=it.get('price'), popular=it.get('popular'))
    im = fetch(it['img'])
    r['measured'] = measured(im)
    e = None
    if models:
        e, r['scores'] = models.score(im)
        r['content_top'], r['content_conf'], r['content'] = pick(models, e, CONTENT)
        r['pairs'] = {k: list(models.probs(e, v).values())[0] for k, v in PAIRS.items()}
        txt = ' '.join(x for x in [it.get('name'), it.get('description')] if x)[:200]
        r['name_sim'] = models.sim(e, [f'a photo of {txt}', 'a logo or brand graphic', 'text or a price list'])
    r['kind'], kind_img = classify(it, e, models)
    r['kind_label'] = KIND_LABEL[r['kind']]
    r['kind_img'] = kind_img
    return r


def score_item(it, models):
    r = measure_item(it, models)
    a = assess(r)
    r.update(grade=a['grade'], label=a['label'], parts=a['parts'], feedback=dict(fix=a['fix'], tip=a['tip'], good=a['good']))
    return r


def run_calibration(models):
    job = rpc('radar_calib_job', {'p': {}})
    items = job['items']
    print(f'calibration: {len(items)} photos')
    for it in items:
        try:
            r = measure_item(it, models)
        except Exception as ex:
            r = dict(error=type(ex).__name__)
        rpc('radar_calib_result', {'p_id': int(it['id']), 'p_model': r})
    print('calibration done')


def main():
    t0 = time.time()
    if MODE == 'calib':
        run_calibration(Models()); return
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
    if not (SUPABASE_URL and SUPABASE_KEY and (TICKET or MODE == 'calib')):
        sys.exit('missing env')
    try:
        main()
    except Exception as ex:
        traceback.print_exc(limit=2)
        if MODE != 'calib':
            try:
                finish(None, type(ex).__name__)
            except Exception:
                pass
        sys.exit(1)
