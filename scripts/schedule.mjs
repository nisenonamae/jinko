// 人工反射の合図のスケジューラ(GitHub Actions で毎朝1回動く)
// その日の合図の時刻を、反射ごとにランダムに決め(来ない時間は除く)、ntfy の予約配信で「その時刻に届けて」と送っておく。
// 決めた時刻は、記録のリポジトリの roadmap/apps/jinko/cues/日付.json に残す(人工反射が「応答のなかった合図」を見つけるため)。
// 人工反射の画面には、これからの合図の時刻は出さない(出すと、いつ来るか分かってしまうので)。
// 合図ごとに、もう1つ「発動」の知らせを、合図 + 線(その反射の今の当たりの線)の時刻に予約する。音は出さない(優先度1)。
// スマホの MacroDroid が「発動」を見て、まだ解除されていなければ、不快信号をエスカレートさせる。
const env = process.env;
const DAY = 864e5, JST = 9 * 3600e3;
export const jstDate = ms => new Date(ms + JST).toISOString().slice(0, 10);
export const jstMin = ms => { const d = new Date(ms + JST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// 「00:00-07:00, 13:00-15:30」→ 分の区間。日付をまたぐ「23:00-07:00」もよい
export function parseQuiet(s){
  const out = [];
  String(s || "").split(/[,、\s]+/).filter(Boolean).forEach(p => { const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(p); if (!m) return;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4]; if (a < b) out.push([a, b]); else if (a > b) { out.push([a, 1440]); out.push([0, b]); } });
  return out;
}
// その日の合図の時刻(ミリ秒)を決める。startMs より後、来ない時間の外、合図どうしは minGap 分以上あける
export function plan(rx, dayStartMs, startMs, rand, minGap){
  const quiet = parseQuiet(rx.quiet), ok = m => !quiet.some(([a, b]) => m >= a && m < b);
  const first = Math.max(0, Math.ceil((startMs - dayStartMs) / 60000));
  const mins = []; for (let m = first; m < 1440; m++) if (ok(m)) mins.push(m);
  const n = Math.max(0, Math.min(60, Math.round(+rx.perDay || 0)));
  const picked = [];
  for (let tries = 0; picked.length < n && tries < n * 60 && mins.length; tries++) {
    const m = mins[Math.floor(rand() * mins.length)];
    if (picked.every(x => Math.abs(x - m) >= minGap)) picked.push(m);
  }
  return picked.sort((a, b) => a - b).map(m => dayStartMs + m * 60000 + Math.floor(rand() * 60000));
}
export const cueText = rx => rx.kind === "再現" ? (rx.b && rx.b.what) || "B" : (rx.c && rx.c.what) || "動く";
// 通知の名前。MacroDroid が「含む」で見分けるので、片方がもう片方を含まないようにする
export const CUE_TITLE = "合図(人工反射)", FIRE_TITLE = "不快信号(人工反射)";

export async function main(){
  const { DATA_REPO, DATA_TOKEN, NTFY_TOPIC } = env, BR = env.DATA_BRANCH || "main", NTFY = env.NTFY_SERVER || "https://ntfy.sh", APP = env.APP_URL, GAP = +(env.MIN_GAP_MIN || 15);
  if (!DATA_REPO || !DATA_TOKEN || !NTFY_TOPIC || !APP) throw new Error("DATA_REPO・DATA_TOKEN・NTFY_TOPIC・APP_URL を設定してください");
  const api = "https://api.github.com/repos/" + DATA_REPO, H = { Authorization: "Bearer " + DATA_TOKEN, Accept: "application/vnd.github+json" };
  const read = async p => { const r = await fetch(api + "/contents/" + p + "?ref=" + BR, { headers: H }); if (r.status === 404) return { text: null, sha: null }; if (!r.ok) throw new Error("読み込みに失敗(" + r.status + " " + p + ")"); const j = await r.json(); return { text: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha }; };
  const write = async (p, text, sha) => { const r = await fetch(api + "/contents/" + p, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify(Object.assign({ message: "人工反射:今日の合図", content: Buffer.from(text, "utf8").toString("base64"), branch: BR }, sha ? { sha } : {})) }); if (!r.ok) throw new Error("書き込みに失敗(" + r.status + ")"); };
  const d = await read("roadmap/apps/jinko/data.json"); if (!d.text) { console.log("反射がまだありません"); return; }
  const data = JSON.parse(d.text), now = Date.now(), date = jstDate(now), dayStart = Date.parse(date + "T00:00:00+09:00");
  const path = "roadmap/apps/jinko/cues/" + date + ".json", cur = await read(path), file = cur.text ? JSON.parse(cur.text) : { date, cues: [] };
  const planned = new Set(file.cues.map(c => c.r)), start = now + 10 * 60000;   // 少なくとも10分先から
  const rxs = (data.reflexes || []).filter(x => !x.archived && +x.perDay > 0 && !planned.has(x.id));
  let sent = 0;
  for (const rx of rxs) {
    const times = plan(rx, dayStart, start, Math.random, GAP);
    for (let i = 0; i < times.length; i++) {
      const at = times[i], id = date.replace(/-/g, "") + "-" + rx.id + "-" + (i + 1);
      const click = APP + (APP.includes("?") ? "&" : "?") + "cue=" + encodeURIComponent(id) + "&r=" + encodeURIComponent(rx.id) + "&at=" + at;
      const r = await fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: NTFY_TOPIC, title: CUE_TITLE, message: CUE_TITLE + ":" + cueText(rx), priority: 5, tags: ["zap"], click, delay: String(Math.floor(at / 1000)) }) });
      if (!r.ok) throw new Error("ntfy への予約に失敗(" + r.status + ")");
      // 発動の瞬間:最短時間〜上限(不快信号までの時間)のあいだで毎回ランダム(ランダムを切った反射は上限ちょうど)
      const max = Math.max(1, +rx.limit || +rx.limit0 || 30), min = Math.min(max, Math.max(0, +rx.minTime || 0));
      const line = Math.round((rx.randomFire === false ? max : min + Math.random() * (max - min)) * 10) / 10, fire = at + Math.round(line * 1000);
      const r2 = await fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: NTFY_TOPIC, title: FIRE_TITLE, message: FIRE_TITLE + ":" + cueText(rx) + "。今すぐ", priority: 1, click: click + "&src=esc", delay: String(Math.floor(fire / 1000)) }) });
      if (!r2.ok) throw new Error("ntfy への予約に失敗(" + r2.status + ")");
      file.cues.push({ id, r: rx.id, at, line, min }); sent++;
    }
  }
  file.cues.sort((a, b) => a.at - b.at);
  if (sent) await write(path, JSON.stringify(file), cur.sha);
  console.log("今日の合図を " + sent + " 回予約しました(" + date + ")");
}
if (import.meta.url === "file://" + process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
