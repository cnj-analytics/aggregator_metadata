"""
Menu image analysis — one run per menu request (ticket), started by Supabase.

  1. radar_image_job(ticket)        -> the menu's items + image URLs (from the menu analysis already done)
  2. download each image at app size, score it (measured checks, technical quality, aesthetics, CLIP content checks)
  3. radar_image_progress(...)      -> progress for the loading bar, every few images
  4. radar_image_done(...)          -> the finished per-item report + menu summary

Nothing is written to disk outside the container and nothing is logged except counts
(this repo is public, so its logs are public).

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICKET
"""
import io, os, sys, math, time, json, traceback
import numpy as np, requests
from PIL import Image, ImageOps

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
TICKET = os.environ.get('TICKET', '')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
SIZE = 512
METHOD_VERSION = 'v1'


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
    # blown highlights only count on the food itself (a clean white backdrop is deliberate)
    if white_bg and mask.any():
        clip_hi = float((L[mask] > 97).mean() * 100)
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
        self.nima = pyiqa.create_metric('nima', device=torch.device('cpu'))
        self.prompt_cache = {}

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
            x = self.pre(im).unsqueeze(0)
            e = self.clip.encode_image(x)
            e = e / e.norm(dim=-1, keepdim=True)
            aesthetic = float(self.aes(e.float())[0, 0])
            t = torch.from_numpy(np.asarray(im.resize((384, 384))).astype(np.float32) / 255).permute(2, 0, 1).unsqueeze(0)
            technical = float(self.topiq(t)) * 100
            nima = float(self.nima(t))
        return e, dict(aesthetic=round(aesthetic, 2), technical=round(technical, 1), nima=round(nima, 2))

    def probs(self, e, prompts):
        t = self.text(prompts)
        logits = 100.0 * (e @ t.T)[0]
        p = logits.softmax(dim=-1).tolist()
        return {k: round(v * 100, 1) for k, v in zip(prompts, p)}


CONTENT = ['a photo of prepared food or a dish', 'a photo of a drink or beverage', 'a logo or brand graphic', 'text, a menu or a price list',
           'a photo of packaging, a bottle or a takeaway box', 'a photo of a person']
APPEAL = ['an appetizing, delicious-looking food photo', 'an unappetizing, unappealing food photo']
STYLE = ['a professional studio food photograph', 'an amateur smartphone snapshot of food']
SHOT = ['an overhead top-down shot of food', 'a 45-degree angle shot of food on a table', 'a close-up shot of food', 'a side-on shot of food']
SCENE = ['food on a plain seamless background', 'food on a restaurant table or kitchen counter', 'food styled with props and ingredients around it']
EXTRA = {'hands': ['a photo with human hands in it', 'a photo without any people or hands'],
         'overlay': ['a photo with text or a logo printed over it', 'a clean photo with no text on it'],
         'packaging': ['food shown in a takeaway box, bag or wrapper', 'food served on a plate or bowl'],
         'spread': ['several different dishes together', 'one single dish']}


def top(d):
    k = max(d, key=d.get)
    return k, d[k]


# ---------------------------------------------------------------- feedback rules (deterministic, each tied to a check)
def feedback(r, menu):
    fix, tip, good = [], [], []
    m = r['measured']
    if m['blank']:
        fix.append('Looks like a placeholder or near-blank image, not a real photo of the item.')
        return dict(fix=fix, tip=tip, good=good)
    if r.get('content') and r['content_top'] != 'food':
        what = {'drink': None, 'logo': 'a logo or brand graphic', 'text': 'text or a menu', 'packaging': 'packaging rather than the food', 'person': 'a person'}[r['content_top']]
        if what:
            fix.append(f'The photo mainly shows {what} ({r["content_conf"]:.0f}% confidence), not the dish.')
    if r.get('match') and r['match']['rank'] > 3 and r['match']['of'] >= 5:
        fix.append(f'The photo looks more like “{r["match"]["best"]}” than this item (it ranks #{r["match"]["rank"]} of {r["match"]["of"]} item names). Check it is the right photo.')
    if m['sharpness'] < 30:
        fix.append('Soft or blurry: edges are not crisp. Reshoot with the focus on the food, or use a sharper original.')
    elif m['sharpness'] > 75:
        good.append('Crisp detail.')
    if m['w'] < 400 or m['h'] < 400:
        fix.append(f'Low resolution ({m["w"]}×{m["h"]} px); it will look pixelated on large phones.')
    if m['brightness'] < menu['bright_p20'] and m['brightness'] < 42:
        fix.append(f'Underexposed: darker than {menu_pct(r, "brightness", menu, low=True)}% of this menu. Brighten, or reshoot in more light.')
    if m['clip_hi'] > 8:
        fix.append(f'Blown-out highlights: {m["clip_hi"]:.0f}% of the image is pure white with no detail.')
    if m['contrast'] < 14 and not m['blank']:
        tip.append('Flat, low-contrast look; a little more contrast would make the dish pop.')
    if m['colourfulness'] < 20 and not m['blank']:
        tip.append('Muted colours; the food looks dull compared with typical menu photos.')
    elif m['colourfulness'] > 45:
        good.append('Vivid, appetising colour.')
    if m['noise'] > 6:
        tip.append('Visible grain/noise, often from low light.')
    if m['fill'] < 30 and not m['blank']:
        tip.append(f'The food fills only about {m["fill"]:.0f}% of the frame; crop tighter so the dish is the hero.')
    elif m['touches_edges'] >= 3:
        tip.append('The dish is cut off on several sides; leave a little space around it.')
    if m['busy_bg'] and r.get('scene') != 'styled':
        tip.append('Busy background competes with the dish.')
    if m['plain_bg']:
        good.append('Clean, uncluttered background.' if not m['white_bg'] else 'Clean white background (consistent catalogue look).')
    x = r.get('extra', {})
    if x.get('hands', 0) > 70:
        tip.append('Hands are visible in the shot.')
    if x.get('overlay', 0) > 70:
        fix.append('Text or a logo is printed over the photo; delivery apps work best with clean food photos.')
    if x.get('packaging', 0) > 70:
        tip.append('Food is shown in takeaway packaging; plated shots usually look more appetising.')
    if r.get('dup_of'):
        fix.append(f'Same photo as {len(r["dup_of"])} other item{"s" if len(r["dup_of"]) != 1 else ""} ({", ".join(r["dup_of"][:3])}).')
    s = r.get('scores', {})
    if s:
        if s['aesthetic'] >= 6:
            good.append('Strong overall visual appeal.')
        elif s['aesthetic'] < 4.5:
            tip.append('Low visual appeal score; styling, light or angle could be improved.')
        if s['technical'] < 40:
            tip.append('Low technical quality score (compression, blur or noise).')
    if r.get('appeal') is not None:
        if r['appeal'] >= 70:
            good.append('Reads as appetising.')
        elif r['appeal'] < 35:
            tip.append('Reads as unappetising to the image model; consider re-styling or relighting.')
    return dict(fix=fix, tip=tip, good=good)


def menu_pct(r, key, menu, low=False):
    vals = menu['vals'][key]
    v = r['measured'][key]
    n = sum(1 for x in vals if (x > v if low else x < v))
    return round(n / max(1, len(vals)) * 100)


def grade(r):
    """0-100 photo grade. Weights are published in the report's 'How we assess' note."""
    m, s = r['measured'], r.get('scores') or {}
    if m['blank']:
        return 5
    parts = []
    if s:
        parts.append((0.30, max(0, min(100, s['technical']))))
        parts.append((0.30, max(0, min(100, (s['aesthetic'] - 3) / 4 * 100))))
    parts.append((0.15, m['sharpness']))
    expo = 100 - min(100, abs(m['brightness'] - 60) * 2.2 + m['clip_hi'] * 3 + m['clip_lo'] * 3)
    parts.append((0.10, max(0, expo)))
    parts.append((0.10, max(0, min(100, m['colourfulness'] * 1.8))))
    if r.get('appeal') is not None:
        parts.append((0.05, r['appeal']))
    tw = sum(w for w, _ in parts)
    g = sum(w * v for w, v in parts) / tw
    pen = 0
    if r.get('dup_of'): pen += 10
    if r.get('content_top') not in (None, 'food', 'drink'): pen += 25
    if r.get('match') and r['match']['rank'] > 3 and r['match']['of'] >= 5: pen += 10
    if m['w'] < 400 or m['h'] < 400: pen += 10
    return int(round(max(0, min(100, g - pen))))


def main():
    t0 = time.time()
    job = rpc('radar_image_job', {'p_ticket': int(TICKET)})
    if not job or job.get('status') == 'gone':
        print('request expired'); return
    items = [i for i in job['items'] if i.get('img')]
    total = len(items)
    print(f'images: {total}')
    rpc('radar_image_progress', {'p_ticket': int(TICKET), 'p_done': 0, 'p_total': total, 'p_stage': 'loading models'})
    try:
        models = Models()
    except Exception:
        traceback.print_exc(limit=1)
        models = None
    import imagehash
    names = [i['name'] for i in items]
    name_emb = models.text([f'a photo of {n}' for n in names]) if models and len(names) >= 2 else None
    results, failed = [], 0
    for k, it in enumerate(items):
        r = dict(id=it['id'], name=it['name'], category=it.get('category'), price=it.get('price'), popular=it.get('popular'))
        try:
            im = fetch(it['img'])
            r['measured'] = measured(im)
            r['phash'] = str(imagehash.phash(im))
            if models:
                e, sc = models.score(im)
                r['scores'] = sc
                c = models.probs(e, CONTENT)
                ck = ['food', 'drink', 'logo', 'text', 'packaging', 'person']
                cd = dict(zip(ck, c.values()))
                r['content'] = cd
                r['content_top'], r['content_conf'] = top(cd)
                r['appeal'] = list(models.probs(e, APPEAL).values())[0]
                r['studio'] = list(models.probs(e, STYLE).values())[0]
                r['shot'] = ['overhead', '45-degree', 'close-up', 'side-on'][int(np.argmax(list(models.probs(e, SHOT).values())))]
                r['scene'] = ['plain', 'table', 'styled'][int(np.argmax(list(models.probs(e, SCENE).values())))]
                r['extra'] = {key: list(models.probs(e, pr).values())[0] for key, pr in EXTRA.items()}
                if name_emb is not None:
                    sims = (e @ name_emb.T)[0].tolist()
                    order = sorted(range(len(names)), key=lambda j: -sims[j])
                    r['match'] = dict(rank=order.index(k) + 1, of=len(names), best=names[order[0]])
        except Exception as ex:
            failed += 1
            r['error'] = type(ex).__name__
        results.append(r)
        if (k + 1) % 3 == 0 or k + 1 == total:
            rpc('radar_image_progress', {'p_ticket': int(TICKET), 'p_done': k + 1, 'p_total': total, 'p_stage': 'scoring'})

    ok = [r for r in results if 'measured' in r]
    # duplicates across the menu (perceptual hash distance <= 6)
    for a in ok:
        ha = imagehash.hex_to_hash(a['phash'])
        a['dup_of'] = [b['name'] for b in ok if b is not a and ha - imagehash.hex_to_hash(b['phash']) <= 6]
    menu = dict(vals={k: [r['measured'][k] for r in ([x for x in ok if not x['measured']['blank']] or ok)] for k in ('brightness', 'sharpness', 'colourfulness', 'warmth')})
    menu['bright_p20'] = float(np.percentile(menu['vals']['brightness'], 20)) if ok else 0
    for r in ok:
        r['grade'] = grade(r)
        r['feedback'] = feedback(r, menu)
        r.pop('phash', None)
    summary = summarise(ok, results, failed, models is not None)
    rpc('radar_image_done', {'p_ticket': int(TICKET), 'p_result': dict(version=METHOD_VERSION, models=models is not None,
        seconds=round(time.time() - t0), summary=summary, items=results)})
    print(f'done: {len(ok)} scored, {failed} failed, {round(time.time() - t0)}s')


def summarise(ok, results, failed, has_models):
    if not ok:
        return dict(images=len(results), failed=failed, notes=['No images could be analysed.'])
    g = [r['grade'] for r in ok]
    avg = lambda k: round(float(np.mean([r['measured'][k] for r in ok])), 1)
    notes, fixes = [], []
    band = lambda v: 'A' if v >= 80 else 'B' if v >= 65 else 'C' if v >= 50 else 'D' if v >= 35 else 'E'
    dist = {b: sum(1 for v in g if band(v) == b) for b in 'ABCDE'}
    dups = sum(1 for r in ok if r.get('dup_of'))
    if dups: notes.append((f'{dups} items share a photo with another item.' if dups > 1 else '1 item shares a photo with another item.'))
    blank = sum(1 for r in ok if r['measured']['blank'])
    if blank: notes.append((f'{blank} images look like placeholders.' if blank > 1 else '1 image looks like a placeholder.'))
    real = [r for r in ok if not r['measured']['blank']] or ok
    blurry = sum(1 for r in real if r['measured']['sharpness'] < 30)
    if blurry: notes.append((f'{blurry} images are soft or blurry.' if blurry > 1 else '1 image is soft or blurry.'))
    # consistency: how varied is the look across the menu
    bstd = float(np.std([r['measured']['brightness'] for r in real]))
    wstd = float(np.std([r['measured']['warmth'] for r in real]))
    plain = sum(1 for r in real if r['measured']['plain_bg'])
    mixed_bg = 0.25 < plain / len(real) < 0.75
    consistency = int(round(max(0, 100 - bstd * 2.5 - wstd * 3 - (20 if mixed_bg else 0))))
    if bstd > 12: notes.append('Brightness varies a lot from photo to photo; the menu looks inconsistent.')
    if wstd > 6: notes.append('Colour temperature varies (some warm, some cool); a shared editing style would help.')
    if mixed_bg: notes.append(f'Mixed backgrounds: {plain} plain vs {len(real) - plain} busy or in-scene.')
    shots = {}
    if has_models:
        for r in ok:
            if r.get('shot'): shots[r['shot']] = shots.get(r['shot'], 0) + 1
        if shots and max(shots.values()) / len(ok) < 0.5:
            notes.append('Camera angles are mixed (' + ', '.join(f'{v} {k}' for k, v in sorted(shots.items(), key=lambda x: -x[1])) + ').')
        wrong = sum(1 for r in ok if r.get('content_top') not in (None, 'food', 'drink'))
        if wrong: notes.append((f'{wrong} images show' if wrong > 1 else '1 image shows') + ' a logo, text, packaging or a person instead of the dish.')
    cats = {}
    for r in ok:
        cats.setdefault(r.get('category') or '—', []).append(r['grade'])
    cat_avg = sorted(((c, round(float(np.mean(v)))) for c, v in cats.items() if len(v) >= 2), key=lambda x: x[1])
    prices = sorted([r['price'] for r in ok if r.get('price') is not None])
    p75 = prices[int(len(prices) * 0.75)] if prices else None
    for r in sorted(ok, key=lambda r: r['grade']):
        if r['grade'] < 55 and (r.get('popular') or (p75 is not None and (r.get('price') or 0) >= p75)):
            fixes.append(dict(id=r['id'], name=r['name'], grade=r['grade'], why='popular item' if r.get('popular') else 'high-priced item'))
    return dict(images=len(results), analysed=len(ok), failed=failed, grade=round(float(np.mean(g))), bands=dist,
                consistency=consistency, sharpness=avg('sharpness'), brightness=avg('brightness'), colourfulness=avg('colourfulness'),
                aesthetic=round(float(np.mean([r['scores']['aesthetic'] for r in ok if r.get('scores')])), 2) if has_models else None,
                technical=round(float(np.mean([r['scores']['technical'] for r in ok if r.get('scores')])), 1) if has_models else None,
                weakest_categories=cat_avg[:3], priority=fixes[:8], shots=shots,
                best=[r['id'] for r in sorted(ok, key=lambda r: -r['grade'])[:5]], worst=[r['id'] for r in sorted(ok, key=lambda r: r['grade'])[:5]],
                notes=notes)


if __name__ == '__main__':
    try:
        main()
    except Exception as ex:
        print('failed:', type(ex).__name__)
        try:
            rpc('radar_image_done', {'p_ticket': int(TICKET), 'p_result': None, 'p_error': type(ex).__name__})
        except Exception:
            pass
        sys.exit(1)
