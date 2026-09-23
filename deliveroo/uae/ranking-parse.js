// ranking-parse.js
//
// Pure parsing helpers for the Deliveroo area full-listing page
// (/en/restaurants/{city}/{area}?collection=restaurants&collection=all-restaurants).
// No network or database access here, so it can be tested on saved HTML.

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

function cleanText(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function extractNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const end = html.indexOf('</script>', from);
  if (end === -1) return null;
  return JSON.parse(html.slice(from, end));
}

// --- Field rules ------------------------------------------------------------

// partner-rating.content: "4.7" -> rated, "New on Deliveroo" -> new, missing -> not rated
function parseRating(raw) {
  const t = cleanText(raw);
  if (t === null) return { status: 'not_rated', rating: null, anomaly: null };
  if (/new/i.test(t)) return { status: 'new', rating: null, anomaly: null };
  const n = parseFloat(t.replace(',', '.'));
  if (!Number.isNaN(n) && n >= 0.1 && n <= 5) {
    return { status: 'rated', rating: Math.round(n * 10) / 10, anomaly: null };
  }
  return { status: 'not_rated', rating: null, anomaly: `rating:${t}` };
}

// partner-rating-count.content: "(123)", "(500+)", "-271" -> 123, 500, 271 (capped at 500)
function parseRatingCount(raw) {
  const t = cleanText(raw);
  if (t === null) return null;
  const m = t.match(/\d[\d,]*/);
  if (!m) return null;
  const n = Math.abs(parseInt(m[0].replace(/,/g, ''), 10));
  return Number.isNaN(n) ? null : Math.min(n, 500);
}

// home-units-delivery-time + label: "25"+"min", "Around"+"60 min" -> open;
// anything mentioning Pre-order or Tomorrow -> closed
function parseOperating(timeRaw, labelRaw) {
  const time = cleanText(timeRaw) || '';
  const label = cleanText(labelRaw) || '';
  const both = `${time} ${label}`.trim();
  if (/pre-?order|tomorrow/i.test(both)) return { status: 'closed', text: both, anomaly: null };
  if (/^\d+$/.test(time) || /^around$/i.test(time)) return { status: 'open', text: both, anomaly: null };
  // Unexpected wording: treat as open (it is listed with a delivery time) but report it.
  return { status: 'open', text: both, anomaly: both ? `delivery_time:${both}` : 'delivery_time:<empty>' };
}

// promotional-sponsor-promo-badge-label.content -> scope
function classifyPromo(text) {
  if (!text) return null;
  if (/free delivery/i.test(text)) return 'free_delivery';
  if (/^spend\b/i.test(text)) return 'spend_x_get_y';
  if (/\bbuy\s*\d+.*get\s*\d+\s*free/i.test(text)) return 'bogo';
  if (/off\s+entire\s+menu/i.test(text)) return 'entire_menu';
  if (/off\s+selected\s+items/i.test(text)) return 'selected_items';
  if (/offers?\s+available/i.test(text)) return 'offers_available';
  return null;
}

function isTrue(v) {
  return v === true || v === 'true';
}

// Card hrefs look like "/menu/Dubai/arabian-ranches-2/mcdonalds-..." or
// "/menu/Abu%20Dhabi/...". Normalise to the stored format:
// https://deliveroo.ae/en/menu/{city-slug}/{area}/{restaurant}
function normaliseMenuUrl(href) {
  if (!href) return null;
  let path = String(href).split('?')[0].split('#')[0];
  path = path.replace(/^https?:\/\/[^/]+/, '');
  const m = path.match(/^(?:\/en)?\/menu\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return path.startsWith('/') ? `https://deliveroo.ae${path}` : null;
  let city;
  try { city = decodeURIComponent(m[1]); } catch (_) { city = m[1]; }
  city = city.trim().toLowerCase().replace(/\s+/g, '-');
  return `https://deliveroo.ae/en/menu/${city}/${m[2]}/${m[3]}`;
}

function imageBase(url) {
  return url ? String(url).split('?')[0] : null;
}

// --- Page -> cards ------------------------------------------------------------

function parseListing(html) {
  const data = extractNextData(html);
  if (!data) return { error: 'no_next_data' };
  const feed = data?.props?.initialState?.home?.feed;
  if (!feed) return { error: 'no_feed' };

  const meta = feed.meta || {};
  const layouts = feed.results?.data || [];
  const cards = [];
  const anomalies = [];
  const unknownPromos = new Map();

  for (const layout of layouts) {
    for (const block of layout.blocks || []) {
      const d = block?.data;
      const onTap = d?.['partner-card.on-tap'];
      if (!onTap) continue;
      const p = onTap.action?.parameters || {};
      const partnerId = block.entityDrnId || p.partner_drn_id;
      if (!partnerId) { anomalies.push('card_without_partner_id'); continue; }

      const rank = cards.length + 1;
      const rating = parseRating(d['partner-rating.content']);
      const count = rating.status === 'rated' ? parseRatingCount(d['partner-rating-count.content']) : null;
      const op = parseOperating(d['home-units-delivery-time.content'], d['home-units-delivery-time-label.content']);
      const promoText = cleanText(d['promotional-sponsor-promo-badge-label.content']);
      const hasPromo = promoText !== null;
      const freeDelivery = hasPromo && /free delivery/i.test(promoText);
      const scope = classifyPromo(promoText);
      if (hasPromo && !scope) unknownPromos.set(promoText, (unknownPromos.get(promoText) || 0) + 1);
      if (rating.anomaly) anomalies.push(rating.anomaly);
      if (op.anomaly) anomalies.push(op.anomaly);

      cards.push({
        partnerId,
        branchId: p.restaurant_id != null ? String(p.restaurant_id) : null,
        name: cleanText(p.restaurant_name || d['partner-name.content']),
        cardUrl: normaliseMenuUrl(p.restaurant_href),
        imageUrl: d['card-image.url'] || null,
        branchType: p.navigate_to_restaurant_branch_type || null,
        row: {
          deliveroo_listing_rank: rank,
          deliveroo_partner_rating_status: rating.status,
          deliveroo_partner_rating: rating.rating,
          deliveroo_partner_rating_count: count,
          deliveroo_partner_operating_status: op.status,
          deliveroo_partner_fast_tag_visible: isTrue(d['props.fast-tag-visible']),
          deliveroo_partner_has_promo_badge: hasPromo,
          deliveroo_partner_has_free_delivery_promo_badge: freeDelivery,
          deliveroo_partner_has_non_delivery_promo_badge: hasPromo && !freeDelivery,
          deliveroo_partner_promo_badge_text: promoText,
          deliveroo_partner_promo_scope: scope,
        },
      });
    }
  }

  return {
    cards,
    anomalies,
    unknownPromos: Object.fromEntries(unknownPromos),
    declaredCount: meta.restaurantCount?.results ?? null,
    locationGeohash: meta.location?.geohash ?? null,
  };
}

module.exports = {
  cleanText, extractNextData, parseRating, parseRatingCount, parseOperating,
  classifyPromo, imageBase, normaliseMenuUrl, parseListing,
};
