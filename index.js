/**
 * SignalIMEI — Bot WhatsApp anti-vol de téléphones
 * Cloudflare Worker + base de données D1 (SQLite). Un seul fichier, aucune configuration manuelle de base.
 * Parcours : vérifier un IMEI / déclarer un vol ou une perte / téléphone retrouvé
 *
 * Secrets à définir dans Cloudflare (Worker > Settings > Variables and Secrets) :
 *   WA_TOKEN         jeton d'accès permanent WhatsApp Cloud API
 *   PHONE_NUMBER_ID  identifiant du numéro WhatsApp (console Meta)
 *   VERIFY_TOKEN     mot secret choisi par toi (vérification du webhook)
 *   APP_SECRET       clé secrète de l'app Meta (Paramètres de l'app > Général)
 */

// ============ CONFIG ============
const PLATFORM_NAME = 'SignalIMEI';   // ← remplace par le nom de ta plateforme
const GRAPH_VERSION = 'v23.0';        // ← vérifie la version en vigueur dans la doc Meta
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_DECLARATIONS_PER_DAY = 3;
const MAX_CHECKS_PER_DAY = 30;
const COMMUNES = ['Abobo', 'Adjamé', 'Attécoubé', 'Cocody', 'Koumassi', 'Marcory', 'Plateau', 'Port-Bouët', 'Treichville', 'Yopougon'];
const isActive = s => s === 'actif' || s === 'a_verifier';
// Statuts : actif | a_verifier (même IMEI déclaré par 2 numéros) | retrouve

// ============ MESSAGES ============
const MSG = {
  welcome: `Bienvenue sur *${PLATFORM_NAME}* 📱\nProtégez-vous contre le vol et le recel de téléphones.\n\nQue voulez-vous faire ?\n\n_En continuant, vous acceptez l'enregistrement de vos déclarations (IMEI et numéro WhatsApp)._`,
  askCheck: `🔍 Envoyez l'*IMEI* (15 chiffres) du téléphone qu'on vous propose.\n\nPour le trouver : composez *#06# sur le téléphone, ou regardez sur la boîte.`,
  askDeclImei: `📝 Envoyez l'*IMEI* (15 chiffres) du téléphone volé ou égaré.\nSi le téléphone a 2 cartes SIM, envoyez les 2 IMEI.\n\nPour le trouver : *#06# sur un téléphone identique, ou la boîte / facture d'achat.\n\n_Envoyez *menu* pour annuler._`,
  askType: `Le téléphone a été :`,
  askModel: `Quelle est la *marque et le modèle* ? (ex : Samsung A14)`,
  askDate: `À quelle *date approximative* ? (ex : hier, 12/10, la semaine dernière)`,
  askCommune: `Dans quelle *commune* ? Choisissez dans la liste, ou écrivez-la.`,
  askFound: `✅ Quel téléphone est retrouvé ? Envoyez l'*IMEI* ou votre *numéro de déclaration* (ex : TV-2026-00123).`,
  badFormat: `⚠️ Je n'ai pas reconnu un IMEI. Il faut *15 chiffres*. Composez *#06# sur le téléphone et renvoyez le numéro.`,
  badFoundInput: `⚠️ Envoyez un IMEI (15 chiffres) ou un numéro de déclaration (ex : TV-2026-00123).`,
  invalid: imei => `⚠️ L'IMEI *${imei}* est invalide (erreur de saisie probable). Vérifiez les chiffres et renvoyez-le.`,
  textOnly: `Je comprends uniquement les messages texte. Envoyez *menu* pour voir les options.`,
  limitChecks: `⏳ Vous avez atteint la limite de vérifications pour aujourd'hui. Réessayez demain.`,
  limitDecl: `⏳ Vous avez atteint la limite de déclarations pour aujourd'hui. Réessayez demain.`,
  alert: r => `🔴 *ALERTE*\nCet IMEI a été signalé *${r.type === 'egare' ? 'égaré' : 'volé'}* (${r.commune}, ${r.date_vol}).\n\n⛔ N'achetez pas ce téléphone. Si vous l'avez en main, rapprochez-vous de la police ou de la gendarmerie.`,
  clear: imei => `🟢 *Aucun signalement* pour l'IMEI ${imei}.\n\n⚠️ Cela ne prouve pas que le téléphone est légitime : demandez la facture et la boîte d'origine.`,
  recap: d => `📋 *Récapitulatif*\nIMEI : ${d.imeis.join(' / ')}\nType : ${d.type === 'egare' ? 'Égaré' : 'Volé'}\nModèle : ${d.model}\nDate : ${d.date}\nCommune : ${d.commune}\n\nTout est correct ?`,
  saved: ref => `✅ Déclaration enregistrée. N° *${ref}*\nGardez ce numéro : il vous servira si le téléphone est retrouvé.\n\nPensez aussi à faire une déclaration à la police.`,
  savedConflict: ref => `✅ Déclaration enregistrée. N° *${ref}*\n\nℹ️ Cet IMEI avait déjà été déclaré depuis un autre numéro : votre déclaration est marquée *à vérifier*. Gardez votre preuve (facture, plainte).`,
  savedDup: ref => `ℹ️ Vous avez déjà déclaré cet IMEI (N° *${ref}*).`,
  cancelled: `Déclaration annulée. Envoyez *menu* pour recommencer.`,
  foundNone: `Aucune déclaration trouvée pour cette référence.`,
  foundAlready: `Cette déclaration est déjà clôturée.`,
  foundNotOwner: `⛔ Seul le numéro WhatsApp qui a fait la déclaration peut la clôturer.`,
  foundOk: ref => `✅ Déclaration *${ref}* clôturée : le téléphone n'est plus signalé. Heureux que vous l'ayez retrouvé !`,
  error: `Désolé, une erreur est survenue. Réessayez dans un instant.`
};

// ============ ENTRÉE DU WORKER ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Vérification du webhook par Meta
    if (request.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe' &&
          url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN) {
        return new Response(url.searchParams.get('hub.challenge'), { status: 200 });
      }
      return new Response(PLATFORM_NAME + ' actif', { status: 200 });
    }

    // Messages entrants : signature contrôlée, réponse immédiate, traitement en arrière-plan
    if (request.method === 'POST') {
      const raw = await request.text();
      const sig = request.headers.get('X-Hub-Signature-256') || '';
      if (!(await validSignature(raw, sig, env.APP_SECRET))) return new Response('Bad signature', { status: 403 });
      let body;
      try { body = JSON.parse(raw); } catch (e) { return new Response('Bad request', { status: 400 }); }
      ctx.waitUntil(processWebhook(body, env).catch(err => console.error(err)));
      return new Response('OK', { status: 200 });
    }

    return new Response('Method not allowed', { status: 405 });
  }
};

async function validSignature(body, header, secret) {
  if (!secret || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (hex.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function processWebhook(body, env) {
  await ensureSchema(env.DB);
  if (Math.random() < 0.02) await cleanup(env);
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value;
      if (!v || !v.messages) continue;                              // accusés de livraison, etc.
      if (!v.metadata || v.metadata.phone_number_id !== env.PHONE_NUMBER_ID) continue;
      for (const msg of v.messages) {
        try {
          const fresh = await env.DB.prepare('INSERT OR IGNORE INTO processed (msg_id, ts) VALUES (?, ?)').bind(msg.id, Date.now()).run();
          if (!fresh.meta.changes) continue;                        // déjà traité (réessai de Meta)
          await handleMessage(env, msg);
        } catch (err) {
          console.error(err);
          await sendText(env, msg.from, MSG.error);
        }
      }
    }
  }
}

// ============ ROUTEUR ============
async function handleMessage(env, msg) {
  const phone = msg.from;
  if (!['text', 'interactive', 'button'].includes(msg.type)) return sendText(env, phone, MSG.textOnly);

  const m = parseMessage(msg);
  const low = m.text.toLowerCase();

  if (['menu', '0', 'annuler', 'bonjour', 'salut'].includes(low)) {
    await clearSession(env, phone);
    return sendMenu(env, phone);
  }
  if (m.id === 'act_check') { await setSession(env, phone, { step: 'check', data: {} }); return sendText(env, phone, MSG.askCheck); }
  if (m.id === 'act_declare') { await setSession(env, phone, { step: 'd_imei', data: {} }); return sendText(env, phone, MSG.askDeclImei); }
  if (m.id === 'act_found') { await setSession(env, phone, { step: 'found', data: {} }); return sendText(env, phone, MSG.askFound); }

  const s = await getSession(env, phone);
  if (s) return handleStep(env, phone, s, m);

  // Sans session : un IMEI envoyé seul = vérification directe
  const imeis = extractImeis(m.text);
  if (imeis) return doCheck(env, phone, imeis);

  return sendMenu(env, phone);
}

async function handleStep(env, phone, s, m) {
  const communeList = () => sendList(env, phone, MSG.askCommune, 'Choisir', COMMUNES.map((c, i) => ['c' + i, c]));
  const typeButtons = () => sendButtons(env, phone, MSG.askType, [['t_vole', 'Volé'], ['t_egare', 'Égaré']]);
  const confirmButtons = () => sendButtons(env, phone, MSG.recap(s.data), [['ok', 'Confirmer'], ['no', 'Annuler']]);

  switch (s.step) {
    case 'check': {
      const imeis = extractImeis(m.text);
      if (!imeis) return sendText(env, phone, MSG.badFormat);
      await clearSession(env, phone);
      return doCheck(env, phone, imeis);
    }
    case 'd_imei': {
      const imeis = extractImeis(m.text);
      if (!imeis) return sendText(env, phone, MSG.badFormat);
      const bad = imeis.filter(i => !isValidImei(i));
      if (bad.length) return sendText(env, phone, MSG.invalid(bad[0]));
      s.data.imeis = imeis;
      s.step = 'd_type';
      await setSession(env, phone, s);
      return typeButtons();
    }
    case 'd_type': {
      let t = null;
      if (m.id === 't_vole' || /vol/i.test(m.text)) t = 'vole';
      else if (m.id === 't_egare' || /gar|perd/i.test(m.text)) t = 'egare';
      if (!t) return typeButtons();
      s.data.type = t;
      s.step = 'd_model';
      await setSession(env, phone, s);
      return sendText(env, phone, MSG.askModel);
    }
    case 'd_model': {
      const t = clean(m.text);
      if (t.length < 2) return sendText(env, phone, MSG.askModel);
      s.data.model = t;
      s.step = 'd_date';
      await setSession(env, phone, s);
      return sendText(env, phone, MSG.askDate);
    }
    case 'd_date': {
      const t = clean(m.text);
      if (t.length < 2) return sendText(env, phone, MSG.askDate);
      s.data.date = t;
      s.step = 'd_commune';
      await setSession(env, phone, s);
      return communeList();
    }
    case 'd_commune': {
      const t = clean(m.text);
      if (t.length < 2) return communeList();
      s.data.commune = t;
      s.step = 'd_confirm';
      await setSession(env, phone, s);
      return confirmButtons();
    }
    case 'd_confirm': {
      if (m.id === 'no' || /^non|annul/i.test(m.text)) {
        await clearSession(env, phone);
        return sendText(env, phone, MSG.cancelled);
      }
      if (m.id === 'ok' || /^oui|confirm/i.test(m.text)) {
        await clearSession(env, phone);
        if (!(await hit(env, 'd', phone, MAX_DECLARATIONS_PER_DAY))) return sendText(env, phone, MSG.limitDecl);
        const results = await saveDeclaration(env, phone, s.data);
        for (const r of results) {
          if (r.dup) await sendText(env, phone, MSG.savedDup(r.ref));
          else await sendText(env, phone, r.conflict ? MSG.savedConflict(r.ref) : MSG.saved(r.ref));
        }
        return;
      }
      return confirmButtons();
    }
    case 'found': {
      const t = m.text.trim().toUpperCase();
      let rows;
      if (/^TV-\d{4}-\d{5,}$/.test(t)) {
        rows = await findRows(env, 'ref', t);
      } else {
        const im = extractImeis(m.text);
        if (!im) return sendText(env, phone, MSG.badFoundInput);
        rows = await findRows(env, 'imei', im[0]);
      }
      await clearSession(env, phone);
      const active = rows.filter(r => isActive(r.statut));
      const mine = active.filter(r => r.declarant === phone);
      if (!rows.length) return sendText(env, phone, MSG.foundNone);
      if (!active.length) return sendText(env, phone, MSG.foundAlready);
      if (!mine.length) return sendText(env, phone, MSG.foundNotOwner);
      for (const r of mine) {
        await env.DB.prepare(`UPDATE declarations SET statut = 'retrouve', date_retrouve = ? WHERE n = ?`).bind(now(), r.n).run();
      }
      await log(env, 'retrouve', mine[0].imei, 'ok', phone);
      return sendText(env, phone, MSG.foundOk(mine[0].ref));
    }
    default:
      await clearSession(env, phone);
      return sendMenu(env, phone);
  }
}

// ============ ACTIONS MÉTIER ============
async function doCheck(env, phone, imeis) {
  if (!(await hit(env, 'c', phone, MAX_CHECKS_PER_DAY))) return sendText(env, phone, MSG.limitChecks);
  for (const imei of imeis) {
    if (!isValidImei(imei)) {
      await log(env, 'verif', imei, 'invalide', phone);
      await sendText(env, phone, MSG.invalid(imei));
      continue;
    }
    const hits = (await findRows(env, 'imei', imei)).filter(r => isActive(r.statut));
    if (hits.length) {
      await env.DB.prepare('UPDATE declarations SET nb_verif = nb_verif + 1 WHERE n = ?').bind(hits[0].n).run();
      await log(env, 'verif', imei, 'ALERTE', phone);
      await sendText(env, phone, MSG.alert(hits[0]));
    } else {
      await log(env, 'verif', imei, 'aucun', phone);
      await sendText(env, phone, MSG.clear(imei));
    }
  }
}

async function saveDeclaration(env, phone, d) {
  const results = [];
  for (const imei of d.imeis) {
    const existing = (await findRows(env, 'imei', imei)).filter(r => isActive(r.statut));
    const mine = existing.filter(r => r.declarant === phone);
    if (mine.length) { results.push({ ref: mine[0].ref, dup: true }); continue; }
    const conflict = existing.length > 0;
    const ins = await env.DB.prepare(
      'INSERT INTO declarations (ref, imei, statut, type, modele, date_vol, commune, declarant, date_decl) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), imei, conflict ? 'a_verifier' : 'actif', d.type, d.model, d.date, d.commune, phone, now()).run();
    const n = ins.meta.last_row_id;
    const ref = 'TV-' + new Date().getUTCFullYear() + '-' + String(n).padStart(5, '0');
    await env.DB.prepare('UPDATE declarations SET ref = ? WHERE n = ?').bind(ref, n).run();
    await log(env, 'declaration', imei, conflict ? 'conflit' : 'ok', phone);
    results.push({ ref, conflict });
  }
  return results;
}

// ============ OUTILS IMEI ============
function isValidImei(s) {                       // 15 chiffres + clé de Luhn
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(s[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function extractImeis(text) {                   // accepte 1 ou 2 IMEI (double SIM), avec espaces/tirets
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.length === 15 || digits.length === 30) return digits.match(/\d{15}/g);
  return null;
}

// ============ BASE DE DONNÉES (D1) ============
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS declarations (
      n INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, imei TEXT NOT NULL, statut TEXT NOT NULL,
      type TEXT, modele TEXT, date_vol TEXT, commune TEXT, declarant TEXT, date_decl TEXT,
      nb_verif INTEGER DEFAULT 0, date_retrouve TEXT)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decl_imei ON declarations (imei)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_decl_ref ON declarations (ref)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (phone TEXT PRIMARY KEY, step TEXT, data TEXT, expires INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS processed (msg_id TEXT PRIMARY KEY, ts INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS logs (ts TEXT, action TEXT, imei TEXT, result TEXT, user TEXT)')
  ]);
  schemaReady = true;
}

async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM processed WHERE ts < ?').bind(Date.now() - 86400000),
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM counters WHERE k NOT LIKE ?').bind('%:' + today())
  ]);
}

async function findRows(env, col, value) {      // col : 'imei' ou 'ref' uniquement
  const c = col === 'ref' ? 'ref' : 'imei';
  const r = await env.DB.prepare(`SELECT * FROM declarations WHERE ${c} = ? ORDER BY n`).bind(value).all();
  return r.results || [];
}

async function log(env, action, imei, result, phone) {
  await env.DB.prepare('INSERT INTO logs (ts, action, imei, result, user) VALUES (?,?,?,?,?)')
    .bind(now(), action, imei, result, await hashPhone(env, phone)).run();
}

async function getSession(env, phone) {
  const r = await env.DB.prepare('SELECT step, data FROM sessions WHERE phone = ? AND expires > ?').bind(phone, Date.now()).first();
  return r ? { step: r.step, data: JSON.parse(r.data) } : null;
}
async function setSession(env, phone, s) {
  await env.DB.prepare('INSERT OR REPLACE INTO sessions (phone, step, data, expires) VALUES (?,?,?,?)')
    .bind(phone, s.step, JSON.stringify(s.data), Date.now() + SESSION_TTL_MS).run();
}
async function clearSession(env, phone) {
  await env.DB.prepare('DELETE FROM sessions WHERE phone = ?').bind(phone).run();
}

async function hit(env, kind, phone, max) {     // limite quotidienne par numéro
  const key = kind + ':' + phone + ':' + today();
  const row = await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(key).first();
  if (row && row.n >= max) return false;
  await env.DB.prepare('INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(key).run();
  return true;
}

// ============ UTILITAIRES ============
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const clean = t => String(t || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);

function now() {                                // Abidjan = UTC+0
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function hashPhone(env, phone) {          // le journal ne garde pas les numéros en clair
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phone + (env.APP_SECRET || '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

function parseMessage(msg) {
  let text = '', id = '';
  if (msg.type === 'text') text = msg.text.body;
  else if (msg.type === 'interactive') {
    const r = msg.interactive.button_reply || msg.interactive.list_reply;
    if (r) { id = r.id; text = r.title; }
  } else if (msg.type === 'button') text = msg.button.text;
  return { text: String(text || '').trim(), id };
}

// ============ ENVOI WHATSAPP ============
async function wa(env, payload) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.WA_TOKEN },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
  });
  if (!res.ok) console.error(res.status, await res.text());
}

const sendText = (env, to, body) => wa(env, { to, type: 'text', text: { body } });

const sendButtons = (env, to, body, buttons) => wa(env, {   // max 3 boutons, titre ≤ 20 caractères
  to, type: 'interactive',
  interactive: {
    type: 'button', body: { text: body },
    action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b[0], title: b[1] } })) }
  }
});

const sendList = (env, to, body, label, rows) => wa(env, { // max 10 lignes, titre ≤ 24 caractères
  to, type: 'interactive',
  interactive: {
    type: 'list', body: { text: body },
    action: { button: label, sections: [{ title: 'Communes', rows: rows.map(r => ({ id: r[0], title: r[1] })) }] }
  }
});

const sendMenu = (env, to) => sendButtons(env, to, MSG.welcome,
  [['act_check', 'Vérifier un IMEI'], ['act_declare', 'Déclarer vol/perte'], ['act_found', 'Téléphone retrouvé']]);
