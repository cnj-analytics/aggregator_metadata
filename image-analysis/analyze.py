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


def scene(im):
    """Scene layout for tabletop photos: the object (plate/cup + food), the food itself (plate removed) and the background.
    The food is what must stand out; the plate is ignored. A busy background only counts when it is in focus."""
    import cv2
    S = 256
    a = np.asarray(im.resize((S, S))).astype(np.uint8)
    lab = cv2.cvtColor(a, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab[..., 0] *= 100 / 255; lab[..., 1] -= 128; lab[..., 2] -= 128
    L = lab[..., 0]
    # object: GrabCut started from a box a little inside the frame
    gm = np.zeros((S, S), np.uint8); bgd = np.zeros((1, 65), np.float64); fgd = np.zeros((1, 65), np.float64)
    m = int(S * .06)
    try:
        cv2.grabCut(a, gm, (m, m, S - 2 * m, S - 2 * m), bgd, fgd, 4, cv2.GC_INIT_WITH_RECT)
        obj = (gm == cv2.GC_FGD) | (gm == cv2.GC_PR_FGD)
    except Exception:
        obj = np.zeros((S, S), bool)
    if obj.mean() < .05 or obj.mean() > .97:
        obj = np.zeros((S, S), bool); obj[int(S * .15):int(S * .85), int(S * .15):int(S * .85)] = True
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    # plate / cup / container: light, colourless, fairly smooth areas inside the object (white or grey ceramic, enamel,
    # paper, a saucer), plus the object's outer ring colour when one colour dominates it. The food is the rest.
    # The plate itself is never judged: only whether the food stands out from whatever is right next to it.
    mu = cv2.blur(L, (5, 5)); sd = np.sqrt(np.maximum(cv2.blur(L * L, (5, 5)) - mu * mu, 0))
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    plate = obj & (chroma < 12) & (L > 62) & (sd < 6)
    ring_o = (cv2.erode(obj.astype(np.uint8), k(3)) > 0) & ~(cv2.erode(obj.astype(np.uint8), k(12)) > 0)
    if ring_o.sum() > 80:
        Z = lab[ring_o].astype(np.float32)
        _, lbl, cen = cv2.kmeans(Z, 3, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1), 3, cv2.KMEANS_PP_CENTERS)
        cnt = np.bincount(lbl.ravel(), minlength=3) / len(lbl); i = int(cnt.argmax())
        if cnt[i] >= .55:
            plate |= obj & (np.linalg.norm(lab - cen[i], axis=2) < 10) & (sd < 6)
    plate = cv2.morphologyEx(plate.astype(np.uint8), cv2.MORPH_OPEN, k(1)) > 0
    food = obj & ~plate
    food = cv2.morphologyEx(food.astype(np.uint8), cv2.MORPH_OPEN, k(1)) > 0
    food = cv2.morphologyEx(food.astype(np.uint8), cv2.MORPH_CLOSE, k(3)) > 0
    plate_found = plate.sum() > obj.sum() * .08
    food_diff_share = float(food.sum() / max(1, obj.sum()) * 100)
    plate_lab = lab[plate].mean(axis=0) if plate.any() else None
    if food.mean() < .02:
        food = obj
    inner = food & ~(cv2.erode(food.astype(np.uint8), k(5)) > 0)
    outer = (cv2.dilate(food.astype(np.uint8), k(8)) > 0) & ~food
    de = lambda x, y: float(np.linalg.norm(x - y))
    mean = lambda msk: lab[msk].mean(axis=0) if msk.any() else np.zeros(3)
    food_sep = de(mean(inner), mean(outer)) if inner.any() and outer.any() else 0.0
    food_sep_all = de(mean(food), mean(outer)) if outer.any() else 0.0
    # per-pixel: how much of the food edge is clearly different from what is right next to it
    near = cv2.dilate(food.astype(np.uint8), k(3)) > 0
    ring = near & ~food
    edge_contrast = 0.0
    if ring.any() and inner.any():
        o_mean = mean(outer)
        edge_contrast = float((np.linalg.norm(lab[inner] - o_mean, axis=1) > 15).mean() * 100)
    # background: everything clearly outside the object
    bgm = ~(cv2.dilate(obj.astype(np.uint8), k(6)) > 0)
    g = cv2.GaussianBlur(L, (0, 0), 0.8)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
    mag = np.hypot(gx, gy)
    lap = cv2.Laplacian(g, cv2.CV_32F)
    bg_share = float(bgm.mean() * 100)
    if bgm.mean() > .03:
        bg_edge = float(mag[bgm].mean()); bg_lap = float(lap[bgm].var()); bg_tex = float(sd[bgm].mean())
        bl = lab[bgm]; bg_colvar = float(np.linalg.norm(bl - bl.mean(axis=0), axis=1).mean())
        bg_strong = float((mag[bgm] > 20).mean() * 100)
    else:
        bg_edge = bg_lap = bg_tex = bg_colvar = bg_strong = 0.0
    obj_lap = float(lap[food].var()) if food.any() else 1.0
    focus_ratio = bg_lap / (obj_lap + 1e-6)
    r1 = lambda v: round(float(v), 2)
    return dict(obj_share=r1(obj.mean() * 100), food_share=r1(food.mean() * 100), plate_found=bool(plate_found), food_diff_share=r1(food_diff_share),
                plate_L=r1(plate_lab[0]) if plate_found else None,
                food_sep=r1(food_sep), food_sep_all=r1(food_sep_all), edge_contrast=r1(edge_contrast),
                bg_share=r1(bg_share), bg_edge=r1(bg_edge), bg_strong=r1(bg_strong), bg_tex=r1(bg_tex), bg_colvar=r1(bg_colvar),
                bg_lap=r1(bg_lap), food_lap=r1(obj_lap), focus_ratio=r1(focus_ratio))


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
    'clutter': ['a cluttered, busy photo with a distracting, noisy background', 'a clean photo with a simple, uncluttered background'],
    'hero': ['a close-up where the food is clearly the hero of the photo', 'a wide shot where the food is small among other objects'],
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
    # weights of the four parts (they set the number inside a label's band)
    w_appeal=.45, w_clarity=.25, w_pres=.20, w_light=.10,
    # Replace: blurry AND pixelated (subject sharpness and real fine detail both very low)
    severe_sharp=40, severe_detail=1.6,
    # Needs work: soft or low resolution
    soft_quality=62, soft_sharp=45, low_res=400,
    # Needs work: light
    dark_share=45, dark_bright=30, washed_bright=85, blown_share=30,
    # background: "white-ish" backdrop = very light and colourless
    white_L=88, white_chroma=12, white_styled=50, unstyled=20,
    # Needs work: product blends into the background, product tiny in the frame
    blend=10, small_fill=12,
    # Excellent needs the product to pop: colour separation and contrast
    pop_sep=29, pop_contrast=25, pop_styled=35,
    # bands
    excellent=90, good=70, needs_work=45)

BANDS = {'excellent': (90, 100), 'good': (70, 89), 'needs_work': (45, 69), 'replace': (5, 44)}
LABELS = [('excellent', 'Excellent'), ('good', 'Good'), ('needs_work', 'Needs work'), ('replace', 'Replace')]


def lin(v, lo, hi):
    return max(0.0, min(100.0, (v - lo) / ((hi - lo) or 1) * 100))


def label_for(g, p=P):
    return 'excellent' if g >= p['excellent'] else 'good' if g >= p['good'] else 'needs_work' if g >= p['needs_work'] else 'replace'


def assess(r, p=P):
    """Grade one photo. The label comes from the problems found (the owner's rules); the number places the photo inside
    that label's band using the four parts (appeal 45%, clarity 25%, presentation 20%, light 10%)."""
    m, s, y, kind = r['measured'], r.get('scores') or {}, r.get('pairs') or {}, r['kind']
    fix, tip, good = [], [], []
    if m['blank']:
        return dict(grade=5, label='replace', fix=['Looks like a placeholder or blank image, not a real photo of the item. Add a real photo.'], tip=[], good=[], parts={})
    food = kind in ('dish', 'drink')
    tech, aes_raw = s.get('technical', 65), s.get('aesthetic', 5)
    styled, csep = y.get('styled', 50), y.get('separation', 50)
    want = y.get('appetising', 50) if food else y.get('pro', 50)
    # ---- the four parts (0-100)
    clarity = .35 * lin(m['sharpness'], 30, 90) + .25 * lin(m['detail'], 1, 5) + .40 * lin(tech, 40, 72)
    appeal = .5 * lin(aes_raw, 4.2, 5.6) + .5 * want
    whiteish = m.get('bg_L', 0) >= p['white_L'] and m.get('bg_chroma', 99) < p['white_chroma']
    pop = .5 * lin(m['separation'], 12, 35) + .5 * lin(m.get('contrast', 20), 10, 30)
    bg = 40 if whiteish else 70 if (m['neutral_bg'] and m['plain_bg']) else 100
    pres = .4 * styled + .4 * pop + .2 * bg
    light = 100 - max(0.0, 45 - m['brightness']) * 2 - max(0.0, m['brightness'] - 75) * 3 - max(0.0, m['dark_share'] - 30) * 1.5 \
        - max(0.0, m['blown_share'] - 10) * 1.5 - max(0.0, m['uneven'] - 25) * 1.2 - (100 - y.get('lit', 60)) * .15
    light = max(0.0, min(100.0, light))
    q = p['w_appeal'] * appeal + p['w_clarity'] * clarity + p['w_pres'] * pres + p['w_light'] * light
    # ---- problems decide the label
    replace, needs = [], []
    visible = r.get('content_top') in ('food', 'drink', 'product') or r.get('content_conf', 0) < 50
    if not visible:
        replace.append('The photo shows only a logo, text or packaging art, not the product itself. Show the item.')
    severe = m['sharpness'] < p['severe_sharp'] and m['detail'] < p['severe_detail']
    small = min(m.get('w', 512), m.get('h', 512)) < p['low_res']
    if severe:
        msg = 'Blurry and pixelated: the photo is out of focus and too low in resolution. Replace it with a sharp, higher-resolution photo.'
        # still clearly recognisable and appetising (the owner's jalapeño-poppers rule): Needs work, not Replace
        (needs if (want >= 70 and tech >= 55) else replace).append(msg)
    elif tech < p['soft_quality'] or m['sharpness'] < p['soft_sharp']:
        needs.append('Soft or slightly blurry: the subject is not crisp. Use a sharper, better-focused photo.')
    if small and not severe:
        needs.append(f"Low resolution ({m.get('w')}×{m.get('h')} px): it will look soft on large phones. Upload a bigger original.")
    if m['dark_share'] > p['dark_share'] or m['brightness'] < p['dark_bright']:
        needs.append('Too dark: much of the photo is in deep shadow. Brighten it or reshoot in better light.')
    if m['brightness'] > p['washed_bright'] or m['blown_share'] > p['blown_share']:
        needs.append('Washed out: bright areas have lost their detail. Reduce the exposure.')
    if whiteish and styled < p['white_styled']:
        needs.append('Plain white background with little styling: the photo looks flat next to other listings. Use a styled, coloured background or props.')
    elif styled < p['unstyled']:
        needs.append('No styling: a plain product shot. Add a background, surface or props that suit the item.')
    if csep < p['blend']:
        needs.append('The product blends into the background and plate (similar colours, little contrast). Use a contrasting background or plate.')
    if m['plain_bg'] and m['fill'] < p['small_fill']:
        needs.append('The product is small in the frame; crop tighter so it is the hero.')
    pops = m['separation'] >= p['pop_sep'] and m.get('contrast', 0) >= p['pop_contrast'] and styled >= p['pop_styled']
    # ---- notes that do not change the label
    if whiteish and styled >= p['white_styled']:
        tip.append('White background: it works here, but a styled, coloured background would make it Excellent.')
    elif not pops and not replace and not needs:
        tip.append('The product does not pop: a background or plate with more contrast and colour would make it Excellent.')
    if m['busy_bg'] and styled < 50 and not pops:
        tip.append('Busy, cluttered background competes with the product.')
    if m['touches_edges'] >= 2 and m['bbox'] > 70:
        tip.append('Tight crop: the product runs off the edges. Leave a little space around it.')
    if m['uneven'] > 30 and not any('dark' in x.lower() or 'washed' in x.lower() for x in needs):
        tip.append('Uneven light: dark shadow in one part and very bright areas in another.')
    if y.get('real', 100) < 20 and y.get('lit', 100) < 30:
        tip.append('May look artificial or composited (the light on the product and the background do not match).')
    if y.get('overlay', 0) >= 85 and kind not in ('packaged', 'merch'):
        tip.append('Text or a logo is printed over the photo.')
    label = 'replace' if replace else 'needs_work' if needs else 'good' if (whiteish or not pops) else 'excellent'
    lo, hi = BANDS[label]
    g = int(round(lo + (hi - lo) * lin(q, 45, 95) / 100))
    # ---- what is working
    if not severe and tech >= p['soft_quality'] and m['sharpness'] >= 60: good.append('Sharp and clear.')
    if want >= 70 and food: good.append('Looks appetising.')
    if styled >= 60 and not whiteish: good.append('Nicely styled.')
    if light >= 80 and not replace: good.append('Well lit.')
    if pops: good.append('Stands out well from the background.')
    return dict(grade=g, label=label, fix=replace + needs, tip=tip, good=good,
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
    try:
        r['scene'] = scene(im)
    except Exception as ex:
        r['scene'] = dict(error=type(ex).__name__)
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
