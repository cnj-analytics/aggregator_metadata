// ranking-parse-mobile.js
//
// Pure parsing helpers for Deliveroo's ANONYMOUS mobile GraphQL FeedV2
// response (POST https://co-m.ae.deliveroo.com/consumer/graphql/).
//
// Drop-in replacement for ranking-parse.js: same exports, same card shape, same
// row keys, so ranking-scrape.js only has to change its require() line. One
// extra row key — `deliveroo_partner_is_sponsored` — is new to this path
// (HTML can't see it).
//
// No network or database access here, so it can be tested on saved JSON
// responses.

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

function cleanText(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

// --- Response unwrapping ----------------------------------------------------

// The mobile endpoint may return either plain JSON or multipart (deferred).
// Extract the first JSON block that contains the data root; the walker then
// doesn't care which shape it came from.
function extractGraphqlJson(responseText) {
  const text = String(responseText);
  if (!text) return null;
  // multipart response starts with "--<boundary>\r\n..."
  if (text.startsWith('--')) {
    const parts = text.split(/--[a-f0-9-]+/i);
    for (const p of parts) {
      const i = p.indexOf('{');
      if (i >= 0 && p.includes('data')) {
        try { return JSON.parse(p.slice(i)); } catch (_) { /* keep trying */ }
      }
    }
    return null;
  }
  try { return JSON.parse(text); } catch (_) { return null; }
}

// Deep-walk every UICard in the response.
function walkUICards(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { for (const v of node) walkUICards(v, out); return out; }
  if (typeof node !== 'object') return out;
  if (node.__typename === 'UICard') out.push(node);
  for (const v of Object.values(node)) walkUICards(v, out);
  return out;
}

// Flatten a card's ui_lines[].ui_spans[].text into one line of text per ui_line.
function uiLines(card) {
  const props = card?.properties?.default || {};
  const out = [];
  for (const ul of (props.ui_lines || [])) {
    const parts = [];
    for (const sp of (ul.ui_spans || [])) {
      const t = sp?.text;
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
    if (parts.length) out.push(parts.join(' '));
  }
  return out;
}

// --- Field rules (match ranking-parse.js) -----------------------------------

// Mobile rating line looks like "4.5 (123)" or "4.5 (500+)". No rating -> not rated;
// "New on Deliveroo" -> new.
function parseRating(all_text) {
  if (!all_text) return { status: 'not_rated', rating: null, count: null, anomaly: null };
  const m = /(\d\.\d)\s*\((\d+[+kK]?)\)/.exec(all_text);
  if (m) {
    const n = parseFloat(m[1]);
    if (!Number.isNaN(n) && n >= 0.1 && n <= 5) {
      const rawCount = m[2].replace(/\+|k|K/g, '');
      const count = Math.min(Math.abs(parseInt(rawCount, 10)) || 0, 500);
      return { status: 'rated', rating: Math.round(n * 10) / 10, count, anomaly: null };
    }
    return { status: 'not_rated', rating: null, count: null, anomaly: `rating:${m[0]}` };
  }
  if (/new on deliveroo/i.test(all_text)) return { status: 'new', rating: null, count: null, anomaly: null };
  return { status: 'not_rated', rating: null, count: null, anomaly: null };
}

// Mobile shows the delivery time in a line like "25 min" or "~30 min" when open;
// pre-order / tomorrow / future time wording when closed.
function parseOperating(all_text) {
  if (!all_text) return { status: 'open', anomaly: null };
  if (/pre-?order|tomorrow/i.test(all_text)) return { status: 'closed', anomaly: null };
  // Open status is the default — a listing-visible card is open unless flagged above.
  return { status: 'open', anomaly: null };
}

// Fast-tag detection on mobile: the HTML "fast-tag-visible" flag has no exact
// counterpart, so we approximate by looking for the badge wording in text spans.
// This under-reports vs the HTML path and we accept that (fast tag is a weak
// signal; the strong signals — rating, promo, sponsored — are precise).
function detectFastTag(card, all_text) {
  if (/fast delivery|fast tag|top rated/i.test(all_text)) return true;
  // Also look at illustration/badge properties — some locales render the fast
  // badge as an illustration_badge rather than text.
  const props = card?.properties?.default || {};
  const badge = String(props.illustration_badge || props.badge || '').toLowerCase();
  if (badge && /fast|top/.test(badge)) return true;
  return false;
}

// Same scope rules as ranking-parse.js, extended for mobile-only promo text
// (per the Oct 2026 enum additions: percent_off, plus_member).
function classifyPromo(text) {
  if (!text) return null;
  if (/free delivery/i.test(text))                             return 'free_delivery';
  if (/^\s*spend\b/i.test(text))                               return 'spend_x_get_y';
  if (/\bbuy\s*\d+.*get\s*\d+\s*free/i.test(text))             return 'bogo';
  if (/off\s+entire\s+menu/i.test(text))                       return 'entire_menu';
  if (/off\s+selected\s+items/i.test(text))                    return 'selected_items';
  if (/offers?\s+available/i.test(text))                       return 'offers_available';
  if (/\b\d+%\s*off\b/i.test(text))                            return 'percent_off';
  if (/plus\s*member|deliveroo\s*plus/i.test(text))            return 'plus_member';
  return null;
}

// Pick the first non-rating / non-delivery-time ui_line that classifies as a promo.
function pickPromoLine(lines) {
  for (const line of lines) {
    const t = cleanText(line);
    if (!t) continue;
    if (/(\d\.\d)\s*\((\d+[+kK]?)\)/.test(t)) continue;       // rating line
    if (/^\s*(around |~)?\d+\s*min\b/i.test(t)) continue;     // delivery time
    if (/new on deliveroo/i.test(t)) continue;
    if (classifyPromo(t)) return t;
  }
  return null;
}

function imageBase(url) {
  return url ? String(url).split('?')[0] : null;
}

function isTrue(v) {
  return v === true || v === 'true';
}

// --- Card -> card record (same shape ranking-scrape.js already consumes) ----

function cardToRecord(card, rank) {
  const target = card.target || {};
  const r = target.restaurant || {};
  const props = card.properties?.default || {};
  const lines = uiLines(card);
  const all_text = lines.join(' | ');

  const rating = parseRating(all_text);
  const op = parseOperating(all_text);
  const fast_tag = detectFastTag(card, all_text);

  const promoText = pickPromoLine(lines);
  const hasPromo = promoText !== null;
  const freeDelivery = hasPromo && /free delivery/i.test(promoText);
  const scope = classifyPromo(promoText);

  // Sponsored: HTML cannot see this. Mobile exposes ad_id / ad_serve_id on
  // sponsored cards; presence of either marks the slot as promoted inventory.
  const ad_id       = (target.ad_id || props.ad_id || '').toString();
  const ad_serve_id = (card.ad_serve_id || '').toString();
  const is_sponsored = !!(ad_id || ad_serve_id);

  return {
    partnerId: r.drn_id || null,
    branchId: r.id != null ? String(r.id) : null,
    name: cleanText(r.name),
    cardUrl: null, // Mobile FeedV2 has no restaurant-page URL (unlike HTML).
                   // register-branch.js looks this up via the hybrid HTML
                   // fallback path when it sees a card without one.
    imageUrl: props.image || null,
    branchType: r.branch_type || null,
    _rawPromo: promoText,
    _ratingAnomaly: rating.anomaly,
    _operatingAnomaly: op.anomaly,
    row: {
      deliveroo_listing_rank: rank,
      deliveroo_partner_rating_status: rating.status,
      deliveroo_partner_rating: rating.rating,
      deliveroo_partner_rating_count: rating.status === 'rated' ? rating.count : null,
      deliveroo_partner_operating_status: op.status,
      deliveroo_partner_fast_tag_visible: fast_tag,
      deliveroo_partner_has_promo_badge: hasPromo,
      deliveroo_partner_has_free_delivery_promo_badge: freeDelivery,
      deliveroo_partner_has_non_delivery_promo_badge: hasPromo && !freeDelivery,
      deliveroo_partner_promo_badge_text: promoText,
      deliveroo_partner_promo_scope: scope,
      // New on this path (HTML cannot produce this):
      deliveroo_partner_is_sponsored: is_sponsored,
    },
  };
}

// --- Response -> cards (same return shape as ranking-parse.js parseListing) --

// Accepts either a response Object (already JSON-parsed) or a raw text/multipart
// string. ranking-scrape.js' mobile fetcher parses first; keeping both callable
// makes unit tests on saved payloads easier.
function parseListing(responseOrText) {
  const data = (typeof responseOrText === 'string')
    ? extractGraphqlJson(responseOrText)
    : responseOrText;
  if (!data) return { error: 'no_response_body', cards: [], anomalies: [], unknownPromos: {}, declaredCount: null, locationGeohash: null };
  if (data.errors && !data.data) return { error: 'graphql_errors', cards: [], anomalies: [], unknownPromos: {}, declaredCount: null, locationGeohash: null };

  const rawCards = walkUICards(data);
  const anomalies = [];
  const seen = new Set();
  const cards = [];
  const unknownPromos = new Map();

  for (const c of rawCards) {
    // Only cards that actually tag a restaurant go into the ranking. UICards
    // with no restaurant target are banners / category tiles / etc.
    const target = c.target || {};
    if (!target.restaurant) continue;
    const rec = cardToRecord(c, cards.length + 1);
    if (!rec.partnerId) { anomalies.push('card_without_partner_id'); continue; }
    if (seen.has(rec.partnerId)) { anomalies.push('duplicate_partner'); continue; }
    seen.add(rec.partnerId);
    cards.push(rec);
    if (rec._ratingAnomaly) anomalies.push(rec._ratingAnomaly);
    if (rec._operatingAnomaly) anomalies.push(rec._operatingAnomaly);
    if (rec.row.deliveroo_partner_has_promo_badge && !rec.row.deliveroo_partner_promo_scope) {
      const t = rec.row.deliveroo_partner_promo_badge_text;
      unknownPromos.set(t, (unknownPromos.get(t) || 0) + 1);
    }
  }

  // Try to surface a declared count from the feed meta (mobile FeedV2 sometimes
  // carries it on the Feed object). Walk-and-pick-first; absent is fine.
  let declaredCount = null;
  (function walk(n) {
    if (declaredCount !== null || !n || typeof n !== 'object') return;
    if (typeof n.restaurant_count === 'number') { declaredCount = n.restaurant_count; return; }
    if (typeof n.restaurantCount === 'number') { declaredCount = n.restaurantCount; return; }
    for (const v of (Array.isArray(n) ? n : Object.values(n))) walk(v);
  })(data);

  return {
    cards,
    anomalies,
    unknownPromos: Object.fromEntries(unknownPromos),
    declaredCount,
    locationGeohash: null, // mobile is lat/lng-only; the HTML geohash hint doesn't apply
  };
}

module.exports = {
  cleanText,
  extractGraphqlJson,
  walkUICards,
  uiLines,
  parseRating,
  parseOperating,
  classifyPromo,
  pickPromoLine,
  detectFastTag,
  imageBase,
  isTrue,
  cardToRecord,
  parseListing,
};
