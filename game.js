"use strict";
(function () {
  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height; // 論理サイズ（ゲームロジックはこの座標系のまま）

  // HiDPI（Retina）対応：バッキングストアを DPR 倍にして ctx を逆スケール
  // → ゲーム内座標は 960×540 のまま、物理ピクセルは DPR 倍になり鮮明に描画される
  const DPR = window.devicePixelRatio || 1;
  cv.width  = W * DPR;
  cv.height = H * DPR;
  ctx.scale(DPR, DPR);

  // ---------------------------------------------------------------------------
  // 共有エンジン（engine.js）から定数・物理・描画プリミティブを取り込む
  // ---------------------------------------------------------------------------
  const {
    GROUND_Y, CHARGE_MAX, NEAR_GROUND_H, CAM_ANCHOR, CAM_SMOOTH, ZOOM, GROUND_SCREEN_Y,
    PLAYER_W, PLAYER_H, DEATH_Y, ITEM_COLLECT_R, BALL_R,
    COL_ORANGE, COL_BLACK, COL_WHITE, PHYS_BASE
  } = Bound;
  // 可変物理レイヤ：通常は既定値だが、自作ステージ(editor.html)は phys で上書きできる。
  // プレイ・生成の物理はすべて P.* を参照する。
  let P = Object.assign({}, PHYS_BASE);

  // ステージ生成（本編専用の定数。エディタ／engine とは共有しない）
  const SEG_W        = W;          // 一画面分
  const GEN_STEP     = SEG_W / 2;  // 生成・軌道計算の刻み（半画面ごと）
  const START_SAFE_X = SEG_W * 1.4;// 開始直後の安全地帯
  const MARGIN_BASE  = 78;         // 軌道に持たせる初期猶予（各窓の先頭）
  const MARGIN_MIN   = 18;         // 最小猶予
  const MARGIN_SHRINK= 0.0042;     // 距離あたりの猶予縮小量（全体）
  const WINDOW_NARROW= 38;         // 半画面の窓内で進むほど狭める量(px)
  const MAX_WALL_H   = 150;
  const MIN_WALL_H   = 22;
  const MAX_AMPL     = 78;
  const ISLAND_HOLE_MIN = 230;     // 浮島を置く穴幅の絶対下限(px)
  // 浮島は「最大級の穴」だけに置く。穴の最大幅は ≒ 速度×滞空時間(2*BASE_VY/G≒0.575) なので、
  // それより小さい比率にしないと条件を満たさず浮島が出なくなる点に注意。
  const ISLAND_HOLE_FRAC = 0.50;
  const ISLAND_W     = 66;         // 浮島の幅(px)

  // 御褒美のスター：ゴーストの軌道上のランダムな位置に置く（軌道上なので必ず取れる）
  // 見た目半径・取得半径・厚みは engine.js 側（ITEM_R / ITEM_COLLECT_R / ISLAND_H）
  const STAR_CHANCE_MIN = 0.15;    // 星の出現確率（序盤）
  const STAR_CHANCE_MAX = 0.85;    // 星の出現確率（10000m以降）
  const STAR_CHANCE_FULL = 100000; // 最大確率に達するx座標（10000m）

  // 壁・移動壁が「色付き（すり抜け可能）」になる確率。進行するほど増える。
  const COLORED_BASE = 0.12;       // 序盤の色付き割合（残りは白＝すり抜け不可）
  const COLORED_RATE = 0.00006;    // 距離あたりの増加
  const COLORED_MAX  = 0.85;       // 色付き割合の上限

  // 妨害要素どうしの最低間隔は「反応時間(秒)」で管理する（px固定ではなく速度に追従）。
  // 〜2000m は GAP_TIME_SOLO 一定で「目の前の1個ずつ対応」できる余裕を保証。
  // 2000m→6000m で徐々に短縮し、前のジャンプ中に次を仕込む＝先読みが要る難易度へ。
  const GAP_TIME_SOLO = 1.4;       // 〜2000m の障害物間の反応時間(秒)
  const GAP_TIME_MIN  = 0.6;       // 6000m以降の反応時間(秒)
  const GAP_PHASE1_X  = 20000;     // 2000m（ここまではSOLO一定）
  const GAP_PHASE2_X  = 60000;     // 6000m（ここでMINに到達）

  // ---------------------------------------------------------------------------
  // スキル定義（星で購入。購入後はON/OFF切替可能）
  // ---------------------------------------------------------------------------
  const SKILLS = [
    { id: "high",   name: "ハイアーチ",       en: "High Arch",    cost: 15,
      desc: "チャージジャンプの高度低下が半減（高く跳べる）", en2: "Charged jumps keep more height" },
    { id: "slow",   name: "エアブレーキ",     en: "Air Brake",    cost: 20,
      desc: "空中にいる間、時間が少し遅く流れる",             en2: "Time slows while airborne" },
    { id: "white",  name: "ホワイトチェンジ", en: "White Change", cost: 30,
      desc: "カラーチェンジで白に変身できる（白とすり抜け）", en2: "Color switch can turn white" },
    { id: "revive", name: "リバイブ",         en: "Revive",       cost: 40,
      desc: "1回だけ復活して続行。ただしミス時の色は封印",    en2: "Revive once; that color is sealed after" },
    { id: "break",  name: "ブレイクチャージ", en: "Break Charge", cost: 50,
      desc: "チャージが速く短くなり、フルチャージ中は白壁を破壊", en2: "Faster charge; full-charge jump smashes white walls" }
  ];
  const BREAK_CHARGE_TIME = 0.45;  // ブレイクチャージ時のフルチャージ時間(秒)
  const BREAK_GLIDE_FRAC  = 0.625; // 同・チャージ滑走距離の倍率（時間比と同じ＝体感速度は不変）
  const HIGH_HEIGHT_PEN   = 0.22;  // ハイアーチ時の高度低下率（通常0.45）
  const SLOW_SCALE        = 0.80;  // エアブレーキ時の時間倍率

  // ---------------------------------------------------------------------------
  // ステージ定義。req のスキルを所持していると解放。cfg で生成パラメータを上書き。
  // ---------------------------------------------------------------------------
  const STAGES = [
    { id: "gym",   name: "体育館",       en: "Gym",        req: null,
      hint: "基本のエンドレスコート", cfg: {} },
    { id: "attic", name: "キャットウォーク", en: "Catwalk",  req: "high",
      hint: "高い壁だらけ。高度を保って跳び越えろ",
      cfg: { wHole: 0.28, wWall: 0.78, gapSolo: 1.35, gapMin: 0.7, wallMaxH: 200 } },
    { id: "clock", name: "時計塔",       en: "Clockwork",  req: "slow",
      hint: "高速で動く壁の巣。空中の余裕が物を言う",
      cfg: { wHole: 0.14, wWall: 0.34, moverSpeed: 1.8, moverAmpl: 1.25, gapSolo: 1.25, gapMin: 0.6 } },
    { id: "hall",  name: "白の回廊",     en: "White Hall", req: "white",
      hint: "すべてが白。白になれなければ詰む",
      cfg: { coloredBase: 0, coloredRate: 0, coloredMax: 0, whiteIslands: true,
             wHole: 0.34, wWall: 0.72, gapSolo: 1.2, gapMin: 0.55 } },
    { id: "depot", name: "資材倉庫",     en: "Depot",      req: "break",
      hint: "跳び越せない白壁はフルチャージで粉砕",
      cfg: { coloredBase: 0.05, coloredRate: 0.00002, coloredMax: 0.3,
             wHole: 0.16, wWall: 0.80, tallWall: 0.45, gapSolo: 1.55, gapMin: 0.85 } },
    { id: "gaunt", name: "ガントレット", en: "Gauntlet",   req: "revive",
      hint: "高速・高密度の総合試験。命は2つある",
      cfg: { gapSolo: 1.0, gapMin: 0.45, coloredBase: 0.2, coloredMax: 0.9,
             pObsBoost: 0.15, speedBoost: 60 } }
  ];

  // ---------------------------------------------------------------------------
  // 永続データ（星の貯金・所持スキル・ステージ別ベスト）
  // ---------------------------------------------------------------------------
  let starBank = parseInt(localStorage.getItem("cr_bank") || "0", 10) || 0;
  let skills = {};   // { id: 1=所持&ON, 0=所持&OFF }
  try { skills = JSON.parse(localStorage.getItem("cr_skills") || "{}") || {}; } catch (e) { skills = {}; }
  let bests = {};
  try { bests = JSON.parse(localStorage.getItem("cr_bests") || "{}") || {}; } catch (e) { bests = {}; }
  if (!bests.gym) { // 旧バージョンのベストを体育館に引き継ぐ
    const legacy = parseInt(localStorage.getItem("cr_best") || "0", 10) || 0;
    if (legacy) bests.gym = legacy;
  }
  function hasSkill(id)  { return skills[id] !== undefined; }
  function skillOn(id)   { return skills[id] === 1; }
  function saveBank()    { localStorage.setItem("cr_bank", String(starBank)); }
  function saveSkills()  { localStorage.setItem("cr_skills", JSON.stringify(skills)); }
  function saveBests()   { localStorage.setItem("cr_bests", JSON.stringify(bests)); }
  // 解放条件のスキルID一覧（req は文字列 or 配列 or null）。すべて所持で解放。
  function reqIds(st) { const r = st.req; return !r ? [] : (Array.isArray(r) ? r : [r]); }
  function stageUnlocked(st) { return reqIds(st).every(hasSkill); }
  function reqNames(st, key) { // key: "name"(JP) | "en"
    return reqIds(st).map(function (id) {
      const s = SKILLS.find(function (sk) { return sk.id === id; });
      return s ? s[key] : "?";
    }).join("・");
  }

  // ---------------------------------------------------------------------------
  // 自作ステージ（editor.html が localStorage "cr_custom_stages" に保存）を読み込む。
  // STAGES の末尾に追加して、ステージ選択にそのまま並ぶようにする。
  // ---------------------------------------------------------------------------
  function loadCustomStages() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem("cr_custom_stages") || "[]") || []; } catch (e) { list = []; }
    for (let i = STAGES.length - 1; i >= 0; i--) if (STAGES[i].custom) STAGES.splice(i, 1);
    list.forEach(function (s) {
      const m = s.meta || {};
      STAGES.push({
        id: "custom:" + (m.name || "?"), name: m.name || "自作", en: m.en || "Custom",
        req: Array.isArray(m.req) ? m.req : (m.req || null),
        hint: m.hint || "自作ステージ / Custom", cfg: {},
        custom: true, phys: s.phys || {}, length: s.length || 6000,
        obstacles: s.obstacles || [], items: s.items || []
      });
    });
  }
  loadCustomStages();

  const mulberry32 = Bound.mulberry32; // 再現可能なステージ生成用（共有）

  // ---------------------------------------------------------------------------
  // ゲーム状態
  // ---------------------------------------------------------------------------
  let state;            // "title" | "skills" | "play" | "dead"
  let stageSel = 0;     // タイトルで選択中のステージ番号
  let stage = STAGES[0];// プレイ中のステージ
  let bannedColor = null; // リバイブ後に封印された色
  let reviveUsed = false; // このランでリバイブを使ったか
  let invulnT = 0;        // リバイブ直後の無敵時間(秒)
  let bankedThisRun = 0;  // リザルト表示用：このランで貯金された星数
  let customGoalX = 0;    // 自作ステージのゴールx（0=エンドレス）
  let cleared = false;    // 自作ステージをクリアしたか
  let rng;              // 生成用乱数
  let ghost;            // ステージ生成用の通過可能ゴースト
  let obstacles;
  let items;             // 御褒美＆道しるべのスター（正解の軌道上に配置）
  let starsCollected;    // 取得したスター数
  let generatedUpToX;
  let lastObstacleX;    // 直前に置いた妨害要素のx（間隔制御用）
  let player;
  let time;             // ゲーム内経過時間(秒) — 上下する壁の駆動に使用
  let score, best;
  let holding;          // 物理的にボタンが押されているか
  let charge;
  let paused = false;   // 一時停止中か（プレイ中のみ）
  let shakeT;
  let camX = 0;         // カメラのワールドx（描画原点）
  let deadAt = -1;

  // 共有設定：公開URL（itch.io等）。空ならこのページのURLを使う。
  const SHARE_URL = "https://kanai-maru.itch.io/geg";
  let toastMsg = "", toastUntil = 0; // 画面下の一時メッセージ

  // ---------------------------------------------------------------------------
  // チュートリアル（初プレイ時に自動で開始。タイトルからも再生可能）
  //   固定コースをゾーンに区切り、ゾーンごとにガイド文を表示。
  //   ミスしてもゲームオーバーにせず、そのゾーンの手前へ戻してやり直し。
  // ---------------------------------------------------------------------------
  const TUT_DONE_KEY = "cr_tut";
  let tut = null; // null=通常プレイ / {doneAt} チュートリアル中
  // 各ゾーン：until=ゾーン終端x, respawn=ミス時の復帰x, マーカー表示位置 mark
  const TUT_ZONES = [
    { until: 1220, respawn: 60,   mark: 1110,
      jp: "穴だ！ 手前で長押しチャージ → 離して大ジャンプ（押している間は地面を滑走）",
      en: "Hole ahead! Hold to charge (you glide), release to leap" },
    { until: 1928, respawn: 1300, mark: 1914,
      jp: "次は壁。チャージすると低く跳ぶので溜めすぎ注意。滑走で位置を調節し、壁の手前から素直に跳び越えよう",
      en: "A wall. Charging makes jumps LOWER — land short of it, then bounce over" },
    { until: 2834, respawn: 2300, mark: 2817,
      jp: "低い隙間が来る。しっかりチャージして、低空ジャンプでくぐり抜けろ",
      en: "Low gap! Charge up for a low, fast jump to slip through" },
    { until: 3728, respawn: 3200, mark: 3714,
      jp: "黒い壁は跳び越えられない。空中でタップして黒にチェンジ → 同じ色はすり抜け！",
      en: "Black wall — can't jump it. Tap mid-air to turn black and phase through!" },
    { until: 4400, respawn: 3900, mark: -1,
      jp: "完璧！ この調子でどこまでも跳ねていこう",
      en: "Perfect! Keep bouncing as far as you can" }
  ];
  function tutZoneIdx() {
    for (let i = 0; i < TUT_ZONES.length; i++) {
      if (player.x <= TUT_ZONES[i].until) return i;
    }
    return TUT_ZONES.length - 1;
  }

  function buildTutorialCourse() {
    obstacles.length = 0;
    items.length = 0;
    generatedUpToX = 1e9; // ランダム生成を完全に止める
    // 1) 穴（チャージジャンプの練習。幅220pxはノーチャージではほぼ届かない）
    obstacles.push({ type: "hole", x1: 1000, x2: 1220 });
    // 2) 白壁（ノーチャージで跳べる高さ。溜めすぎると低くて当たる）
    obstacles.push({ type: "wall", x: 1900, w: 28, h: 90, color: COL_WHITE });
    // 3) 低い隙間（ゆっくり上下。ノーチャージだと高すぎて上に当たる）
    obstacles.push({ type: "mover", x: 2800, w: 34,
                     center: GROUND_Y - 75, ampl: 12, gapH: 130,
                     phase: 0, speed: 0.8, color: COL_WHITE });
    // 4) 黒い高壁（跳び越え不能。カラーチェンジ必須）
    obstacles.push({ type: "wall", x: 3700, w: 28, h: 280, color: COL_BLACK });
  }

  function startTutorial() {
    stage = STAGES[0];
    best = bests[stage.id] || 0;
    initRun(0xC0FFEE);
    buildTutorialCourse();
    tut = { doneAt: -1 };
    state = "play";
  }

  // ミス時：現在ゾーンの手前へ戻してやり直し（ゲームオーバーにしない）
  function tutRespawn() {
    const z = TUT_ZONES[tutZoneIdx()];
    player.x = z.respawn;
    player.y = GROUND_Y; player.vy = 0; player.onGround = true;
    player.ballColor = COL_ORANGE;
    player.breakJump = false;
    charge = 0;
    invulnT = 0.8;
    shakeT = 0.2;
    camX = player.x - CAM_ANCHOR / ZOOM;
    stopChargeTone();
    playLand();
    showToast("もう一度！ / Try again!");
  }

  function finishTutorial() {
    localStorage.setItem(TUT_DONE_KEY, "1");
    tut = null;
    reset();
    showToast("チュートリアル完了！ / Tutorial complete!");
  }

  best = bests[STAGES[0].id] || 0;

  // ステージ設定の取得（未指定ならデフォルト値）
  function scN(key, def) {
    const v = stage.cfg ? stage.cfg[key] : undefined;
    return v == null ? def : v;
  }
  // スキルを反映した実効パラメータ
  function effChargeTime() { return skillOn("break") ? BREAK_CHARGE_TIME : P.CHARGE_TIME; }
  function effGlideFrac()  { return skillOn("break") ? BREAK_GLIDE_FRAC : 1; }
  function effHeightPen()  { return skillOn("high") ? HIGH_HEIGHT_PEN : P.HEIGHT_PEN; }

  function reset() {
    state = "title";
    stage = STAGES[stageSel];
    initRun(0xC0FFEE); // 固定シード（タイトル背景用）
  }

  function initRun(seed) {
    rng = mulberry32(seed);
    ghost = { x: 0 };
    obstacles = [];
    items = [];
    starsCollected = 0;
    generatedUpToX = 0;
    lastObstacleX = -Infinity;
    cleared = false;
    customGoalX = 0;
    // 物理：自作ステージは phys で上書き、それ以外は既定値
    P = Object.assign({}, PHYS_BASE, (stage && stage.custom && stage.phys) ? stage.phys : {});
    player = {
      x: 60, y: GROUND_Y, vy: 0, vx: P.BASE_VX,
      onGround: true, alive: true, nearGround: true,
      ballColor: COL_ORANGE, breakJump: false
    };
    camX = player.x - CAM_ANCHOR / ZOOM;
    time = 0;
    score = 0;
    holding = false;
    charge = 0;
    paused = false;
    shakeT = 0;
    bannedColor = null;
    reviveUsed = false;
    invulnT = 0;
    bankedThisRun = 0;
    if (stage && stage.custom) {
      // 手作りの障害物・スターを固定配置（手続き生成は止める）
      // 画面外クリーンアップが左端順を前提にするため、左端でソートしておく
      obstacles = JSON.parse(JSON.stringify(stage.obstacles))
                    .sort(function (a, b) { return (a.x1 != null ? a.x1 : a.x) - (b.x1 != null ? b.x1 : b.x); });
      items = JSON.parse(JSON.stringify(stage.items)).sort(function (a, b) { return a.x - b.x; });
      generatedUpToX = 1e9;
      customGoalX = stage.length;
    } else {
      ensureGenerated(player.x + SEG_W * 2);
    }
  }

  function startGame() {
    stage = STAGES[stageSel];
    best = bests[stage.id] || 0;
    initRun((Math.random() * 0xFFFFFFFF) >>> 0);
    state = "play";
  }

  // ---------------------------------------------------------------------------
  // ステージ生成
  //   ゴーストがプレイヤーと同じ物理でランダムに跳ね、その「再現可能な軌道」を
  //   解析的に求める。各放物線アーク（着地〜着地）に対し、軌道を避ける形で
  //   穴・壁・上下する壁を配置する。猶予 margin は距離とともに縮小し、さらに
  //   妨害要素どうしの最低間隔も序盤は広く取る。
  // ---------------------------------------------------------------------------
  function ensureGenerated(targetX) {
    while (generatedUpToX < targetX) genStep();
  }

  // 半画面ぶんずつステージを生成する
  function genStep() {
    const segEnd = generatedUpToX + GEN_STEP;
    while (ghost.x < segEnd) {
      // 放物線アーク（ランダムなチャージ）。障害物はアーク内のみ。着地後すぐ次のアーク。
      const c = rng() < 0.5 ? 0 : rng() * CHARGE_MAX;
      const vy = P.BASE_VY * (1 - c * effHeightPen()); // ゴーストもスキル込みの物理で跳ぶ
      const x0 = ghost.x;
      const vx = runSpeedAt(x0) + c * P.BOOST_MAX; // プレイヤーと同じ距離依存の速度で生成
      const T  = 2 * vy / P.G;
      const landX = x0 + vx * T;
      const apexX = x0 + vx * (vy / P.G);
      const apexY = GROUND_Y - vy * vy / (2 * P.G);
      if (x0 >= START_SAFE_X) {
        placeArcObstacle(x0, landX, apexX, apexY);
      }
      ghost.x = landX;
    }
    generatedUpToX = segEnd;
  }

  // 壁・移動壁の色を選ぶ。序盤は白（すり抜け不可）が多く、進むほど色付きが増える。
  function pickWallColor(dist) {
    const pColored = Math.min(scN("coloredMax", COLORED_MAX),
                              scN("coloredBase", COLORED_BASE) + dist * scN("coloredRate", COLORED_RATE));
    if (rng() < pColored) return rng() < 0.5 ? COL_ORANGE : COL_BLACK;
    return COL_WHITE;
  }

  function placeArcObstacle(x0, landX, apexX, apexY) {
    const dist = x0;
    // 軌道計算は半画面ごとに区切る。各「窓」の先頭で猶予を取り直して広くし、
    // 窓内を進むにつれ狭める（さらに全体距離が進むほど全体的にも狭まる）。
    const winProg = (dist % GEN_STEP) / GEN_STEP;            // 0..1 窓内の進行度
    const globalBase = MARGIN_BASE - dist * MARGIN_SHRINK;   // 距離による全体の縮小
    const margin = Math.max(MARGIN_MIN, globalBase - winProg * WINDOW_NARROW);

    // 妨害要素どうしの最低間隔＝反応時間×現在速度。
    // 序盤は1.4秒（着地→次を見て→必要ならチャージ、まで毎回間に合う＝1個ずつ対応）、
    // 2000m以降6000mへ向けて0.6秒まで短縮（前のジャンプ中に次を仕込む＝先読み要）。
    let gapT;
    const gSolo = scN("gapSolo", GAP_TIME_SOLO), gMin = scN("gapMin", GAP_TIME_MIN);
    if (dist <= GAP_PHASE1_X) gapT = gSolo;
    else if (dist >= GAP_PHASE2_X) gapT = gMin;
    else gapT = gSolo + (gMin - gSolo) *
               (dist - GAP_PHASE1_X) / (GAP_PHASE2_X - GAP_PHASE1_X);
    const spacing = runSpeedAt(x0) * gapT;
    if (x0 - lastObstacleX < spacing) return;

    // 距離が進むほど障害物の出現確率が上がる
    const pObstacle = Math.min(0.95, 0.5 + scN("pObsBoost", 0) + dist * 0.00003);
    if (rng() > pObstacle) return;

    const arcW = landX - x0;
    const clearance = GROUND_Y - apexY;
    const t = rng();
    const wHole = scN("wHole", 0.40), wWall = scN("wWall", 0.70);

    if (t < wHole && arcW > (2 * margin + 70)) {
      const hx1 = x0 + margin, hx2 = landX - margin;
      const hole = { type: "hole", x1: hx1, x2: hx2 };
      // 救済の浮島は「最大級の穴」だけに置く（中サイズの穴には付けない）。
      const islandThreshold = Math.max(ISLAND_HOLE_MIN, runSpeedAt(x0) * ISLAND_HOLE_FRAC);
      if (hx2 - hx1 > islandThreshold) {
        const cx = (hx1 + hx2) / 2;
        hole.island = {
          x1: cx - ISLAND_W / 2, x2: cx + ISLAND_W / 2,
          color: scN("whiteIslands", false) ? COL_WHITE
               : (rng() < 0.5 ? COL_ORANGE : COL_BLACK)
        };
      }
      obstacles.push(hole);
      lastObstacleX = landX;
      // 穴の上空（アーク頂点付近）に配置
      tryPlaceStar(x0, landX, apexY, (hx1 + hx2) / 2);
    } else if (t < wWall) {
      // 資材倉庫など：tallWall の確率で「跳び越え不能な白壁」（破壊専用）を置く
      if (rng() < scN("tallWall", 0)) {
        const h = clearance + 50 + rng() * 60;
        obstacles.push({ type: "wall", x: apexX - 14, w: 28, h: h, color: COL_WHITE, breakable: true });
        lastObstacleX = apexX + 14;
        // 壁の少し手前（助走側）に配置
        tryPlaceStar(x0, landX, apexY, apexX - 35);
        return;
      }
      const h = Math.min(clearance - margin, scN("wallMaxH", MAX_WALL_H));
      if (h > MIN_WALL_H) {
        const color = pickWallColor(dist);
        obstacles.push({ type: "wall", x: apexX - 14, w: 28, h: h, color: color });
        lastObstacleX = apexX + 14;
        // 壁の真上（軌道がギリギリ越える高さ）に配置
        tryPlaceStar(x0, landX, apexY, apexX);
      }
    } else {
      const ampl = Math.min(MAX_AMPL * scN("moverAmpl", 1), (28 + dist * 0.004) * scN("moverAmpl", 1));
      const gapH = 2 * (ampl / scN("moverAmpl", 1) + margin); // 隙間は基準振幅ベースで確保
      const color = pickWallColor(dist);
      obstacles.push({
        type: "mover",
        x: apexX - 17, w: 34,
        center: apexY, ampl: ampl, gapH: gapH,
        phase: rng() * Math.PI * 2,
        speed: (1.4 + rng() * 1.6) * scN("moverSpeed", 1),
        color: color
      });
      lastObstacleX = apexX + 17;
      // 移動壁のギャップ中心（軌道が通過する位置）に配置
      tryPlaceStar(x0, landX, apexY, apexX);
    }
  }

  // 御褒美スターを追加（少し上に浮かせて見やすく）
  function addGuideStar(x, y) {
    items.push({ x: x, y: y - 6 });
  }

  // 障害物の近くにスターを置く（放物線上の sx に配置。確率は距離依存）
  function tryPlaceStar(x0, landX, apexY, sx) {
    const chance = STAR_CHANCE_MIN + (STAR_CHANCE_MAX - STAR_CHANCE_MIN) * Math.min(1, x0 / STAR_CHANCE_FULL);
    if (rng() >= chance) return;
    const f = (sx - x0) / (landX - x0);
    const sy = GROUND_Y - 4 * (GROUND_Y - apexY) * f * (1 - f);
    addGuideStar(sx, sy);
  }

  // 地形クエリ・移動壁ギャップは共有エンジンに委譲（現在の obstacles/色/time を束ねるだけ）
  function holeAt(x) { return Bound.holeAt(obstacles, x); }
  function landableAt(x) { return Bound.landableAt(obstacles, x, player.ballColor); }
  function moverGap(o) { return Bound.moverGap(o, time); }

  // ---------------------------------------------------------------------------
  // 入力
  // ---------------------------------------------------------------------------
  // 初プレイならまずチュートリアルへ（完了/スキップ後は通常スタート）
  function maybeStartGame() {
    if (!localStorage.getItem(TUT_DONE_KEY)) { startTutorial(); return; }
    startGame();
  }

  function press() {
    ensureAudio(); // ユーザー操作のタイミングで音声を有効化
    if (state === "title") { if (stageUnlocked(STAGES[stageSel])) maybeStartGame(); return; }
    if (state === "skills") return; // スキル画面はクリック/タップで操作
    if (state === "dead") { if (time - deadAt > 0.4) startGame(); return; }
    if (paused) return; // 一時停止中はゲーム操作を受け付けない
    if (!player.onGround && !player.nearGround) {
      // 高い空中での押下：ボールの色を切り替える（封印色はスキップ、白はスキルON時のみ）
      const arr = allowedColors();
      const i = arr.indexOf(player.ballColor);
      const next = arr[(i + 1) % arr.length];
      if (next && next !== player.ballColor) {
        player.ballColor = next;
        playSwitch();
      }
      return;
    }
    holding = true;
  }
  function release() {
    if (state === "play") holding = false;
  }

  // 一時停止トグル（プレイ中のみ）
  const PAUSE_BTN = { x: W - 52, y: 14, w: 38, h: 38 };
  function togglePause() {
    if (state !== "play") return;
    paused = !paused;
    if (paused) { holding = false; stopChargeTone(); }
  }
  function inPauseBtn(x, y) {
    return x >= PAUSE_BTN.x && x <= PAUSE_BTN.x + PAUSE_BTN.w
        && y >= PAUSE_BTN.y && y <= PAUSE_BTN.y + PAUSE_BTN.h;
  }
  // クライアント座標 → キャンバス座標（CSS拡大に対応）
  function evToCanvas(e) {
    const r = cv.getBoundingClientRect();
    const src = (e.touches && e.touches[0]) ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * (W / r.width),
             y: (src.clientY - r.top) * (H / r.height) };
  }
  // 結果画面の共有ボタン
  const SHARE_BTN = { w: 260, h: 46, x: Math.round(W / 2 - 130), y: Math.round(H / 2 + 116) };
  function inShareBtn(x, y) {
    return x >= SHARE_BTN.x && x <= SHARE_BTN.x + SHARE_BTN.w
        && y >= SHARE_BTN.y && y <= SHARE_BTN.y + SHARE_BTN.h;
  }
  function showToast(msg) { toastMsg = msg; toastUntil = performance.now() + 2400; }
  function shareScore() {
    const url = SHARE_URL || location.href;
    const text = "🏀 The Great Escape from the Gym：" + score + "m 走破！★" + starsCollected + " / I escaped " + score + "m! (★" + starsCollected + ")";
    // 1) Web Share API（主にモバイル）
    if (navigator.share) {
      navigator.share({ title: "The Great Escape from the Gym", text: text, url: url }).catch(function () {});
      return;
    }
    // 2) X(Twitter) の投稿画面を開く
    const intent = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) +
                   "&url=" + encodeURIComponent(url) + "&hashtags=TheGreatEscapeFromTheGym";
    const w = window.open(intent, "_blank", "noopener,noreferrer");
    // 3) ポップアップがブロックされたらクリップボードにコピー
    if (!w) {
      try { navigator.clipboard.writeText(text + " " + url); showToast("コピーしました / Copied!"); }
      catch (e) { showToast("共有できませんでした / Could not share"); }
    }
  }

  // --- メニューUIのレイアウト ---------------------------------------------
  const CARD_W = 210, CARD_H = 88, CARD_GAP = 16;
  const CARD_X0 = Math.round((W - (CARD_W * 3 + CARD_GAP * 2)) / 2);
  const CARD_Y0 = 168;
  function stageCardRect(i) {
    return { x: CARD_X0 + (i % 3) * (CARD_W + CARD_GAP),
             y: CARD_Y0 + Math.floor(i / 3) * (CARD_H + CARD_GAP),
             w: CARD_W, h: CARD_H };
  }
  const SKILLS_BTN = { x: Math.round(W / 2 - 130), y: 392, w: 260, h: 44 };
  const SKILL_ROW_W = 660, SKILL_ROW_H = 56, SKILL_ROW_GAP = 9, SKILL_Y0 = 120;
  function skillRowRect(i) {
    return { x: Math.round((W - SKILL_ROW_W) / 2),
             y: SKILL_Y0 + i * (SKILL_ROW_H + SKILL_ROW_GAP),
             w: SKILL_ROW_W, h: SKILL_ROW_H };
  }
  const BACK_BTN = { x: 20, y: 20, w: 110, h: 38 };
  const MENU_BTN = { w: 200, h: 40, x: Math.round(W / 2 - 100), y: Math.round(H / 2 + 172) };
  const TUT_BTN  = { x: 20, y: 20, w: 190, h: 36 };               // タイトル：チュートリアル再生
  const TUT_SKIP_BTN = { x: W - 134, y: H - 54, w: 114, h: 38 }; // チュートリアル中：スキップ（右下）
  function inRect(pt, r) { return pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h; }

  function clickSkillRow(i) {
    const sk = SKILLS[i];
    if (!hasSkill(sk.id)) {
      if (starBank >= sk.cost) {
        starBank -= sk.cost; saveBank();
        skills[sk.id] = 1; saveSkills();
        playCoin();
        showToast(sk.name + " を獲得！ / " + sk.en + " unlocked!");
      } else {
        showToast("★が足りません（あと" + (sk.cost - starBank) + "） / Not enough stars");
      }
    } else {
      skills[sk.id] = skillOn(sk.id) ? 0 : 1; saveSkills();
      playSwitch();
    }
  }

  function pointerDown(e) {
    const pt = evToCanvas(e);
    if (state === "play" && inPauseBtn(pt.x, pt.y)) { togglePause(); return; }
    if (state === "play" && tut && inRect(pt, TUT_SKIP_BTN)) { finishTutorial(); return; }
    if (state === "title") {
      ensureAudio();
      if (inRect(pt, SKILLS_BTN)) { state = "skills"; return; }
      if (inRect(pt, TUT_BTN)) { startTutorial(); return; }
      for (let i = 0; i < STAGES.length; i++) {
        if (inRect(pt, stageCardRect(i))) {
          const st = STAGES[i];
          if (!stageUnlocked(st)) {
            showToast("「" + reqNames(st, "name") + "」の獲得で解放 / Unlock with " + reqNames(st, "en"));
          } else if (stageSel === i) {
            maybeStartGame();      // 選択中のカードをもう一度タップでスタート
          } else {
            stageSel = i; playSwitch();
          }
          return;
        }
      }
      return; // タイトルの何もない場所のタップでは始めない（誤操作防止）
    }
    if (state === "skills") {
      ensureAudio();
      if (inRect(pt, BACK_BTN)) { state = "title"; return; }
      for (let i = 0; i < SKILLS.length; i++) {
        if (inRect(pt, skillRowRect(i))) { clickSkillRow(i); return; }
      }
      return;
    }
    if (state === "dead" && time - deadAt > 0.4) {
      if (inShareBtn(pt.x, pt.y)) { shareScore(); return; }
      if (inRect(pt, MENU_BTN)) { reset(); return; }
    }
    press();
  }

  window.addEventListener("keydown", function (e) {
    if (e.code === "Space" || e.key === " ") { e.preventDefault(); if (!e.repeat) press(); }
    else if (e.code === "Escape" && state === "skills") { e.preventDefault(); state = "title"; }
    else if (e.code === "KeyP" || e.code === "Escape") { e.preventDefault(); if (!e.repeat) togglePause(); }
    else if (state === "title" && (e.code === "ArrowRight" || e.code === "ArrowLeft" ||
                                   e.code === "ArrowUp" || e.code === "ArrowDown")) {
      e.preventDefault();
      const d = (e.code === "ArrowRight") ? 1 : (e.code === "ArrowLeft") ? -1 :
                (e.code === "ArrowDown") ? 3 : -3;
      stageSel = (stageSel + d + STAGES.length) % STAGES.length;
    }
    else if (state === "title" && e.code === "KeyS") { e.preventDefault(); state = "skills"; }
  });
  window.addEventListener("keyup", function (e) {
    if (e.code === "Space" || e.key === " ") { e.preventDefault(); release(); }
  });
  cv.addEventListener("mousedown", function (e) { e.preventDefault(); pointerDown(e); });
  window.addEventListener("mouseup", function () { release(); });
  cv.addEventListener("touchstart", function (e) { e.preventDefault(); pointerDown(e); }, { passive: false });
  window.addEventListener("touchend", function (e) { e.preventDefault(); release(); }, { passive: false });

  // ---------------------------------------------------------------------------
  // 更新
  // ---------------------------------------------------------------------------
  function update(dt) {
    if (state === "play" && paused) return; // 一時停止中はフリーズ（時間も進めない）
    // エアブレーキ：空中にいる間は世界全体の時間が遅く流れる（実時間の反応猶予が増える）
    if (state === "play" && skillOn("slow") && player && !player.onGround) dt *= SLOW_SCALE;
    time += dt;
    if (state !== "play") return;

    const p = player;
    if (invulnT > 0) invulnT -= dt;

    // チャージが有効なのは「接地中」か「着地に向けて降下中で地面に近い」ときだけ。
    // 高い空中ではボタンは無効（何も溜まらない）。
    p.nearGround = p.onGround || (p.vy >= 0 && (GROUND_Y - p.y) <= NEAR_GROUND_H);
    const canCharge = holding && p.nearGround;
    if (canCharge) {
      charge = Math.min(CHARGE_MAX, charge + dt / effChargeTime());
    }

    // チャージ音（溜まるほど音階が上がる）。チャージしていない間は止める。
    if (canCharge) { startChargeTone(); updateChargeTone(charge); }
    else { stopChargeTone(); }

    if (p.onGround) {
      if (holding && charge < CHARGE_MAX) {
        // チャージ中は一定速度で前進。フルチャージ(CHARGE_TIME)でちょうど
        // 通常ジャンプ1回分の飛距離（= runSpeed × 滞空時間）だけ進むよう速度を設定。
        // ブレイクチャージ時は時間も滑走距離も同率で短縮（体感の滑走速度は同じ）
        const jumpDist = runSpeedAt(p.x) * (2 * P.BASE_VY / P.G) * effGlideFrac();
        p.vx = jumpDist / effChargeTime();
        p.y = GROUND_Y; p.vy = 0;
      } else if (charge > 0) {
        // チャージ解放ジャンプ（離した瞬間 or 上限到達で自動解放）。
        // 押しっぱなしでもチャージはリセットされ、着地後また0から溜まる。
        launch(charge);
      } else {
        // 着地後すぐの自動ジャンプ（チャージなし）。連続して跳ね続ける。
        launch(0);
      }
    } else {
      // 空中ではチャージしない（押していても何も溜まらない）
      p.vy += P.G * dt;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // 着地 / 落下判定（見た目どおり：地面を超えて落ちたらアウト。FALL_ALLOW の余地あり）
    if (p.y >= GROUND_Y) {
      if (landableAt(p.x)) {   // 通常の地面 or 色違いの浮島に着地
        if (!p.onGround) playLand(); // 着地音（空中→接地の瞬間だけ）
        p.y = GROUND_Y; p.vy = 0; p.onGround = true;
        p.breakJump = false; // 破壊効果はそのジャンプ限り
      } else {
        p.onGround = false; // 穴の上（または同色の浮島）：落下継続
        if (p.y > DEATH_Y) return die();
      }
    }

    checkCollisions();

    // チュートリアル：ゴール到達で完了演出 → 少し待ってタイトルへ
    if (tut) {
      if (tut.doneAt < 0 && p.x >= TUT_ZONES[TUT_ZONES.length - 1].until) tut.doneAt = time;
      if (tut.doneAt >= 0 && time - tut.doneAt > 1.6) { finishTutorial(); return; }
    }

    // 自作ステージ：ゴール到達でクリア
    if (customGoalX && p.x >= customGoalX) return clearStage();

    ensureGenerated(p.x + SEG_W * 2); // 自作は generatedUpToX=1e9 で実質no-op

    const cutoff = p.x - SEG_W;
    while (obstacles.length && obstacleRight(obstacles[0]) < cutoff) obstacles.shift();
    while (items.length && items[0].x < cutoff) items.shift();

    // 道しるべスターの取得判定（ボール中心との距離で判定。集めやすめに余裕を持たせる）
    const bcx = p.x, bcy = p.y - BALL_R;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const dx = it.x - bcx, dy = it.y - bcy;
      if (dx * dx + dy * dy < ITEM_COLLECT_R * ITEM_COLLECT_R) {
        items.splice(i, 1);
        starsCollected++;
        playCoin();
      }
    }

    score = Math.floor(p.x / 10);
    if (shakeT > 0) shakeT -= dt;

    // カメラを滑らかに追従。速度が高いほど基準位置より前に出て前進感が増す。
    // camX はワールド左端。ズームを掛けるので基準はワールド単位に換算する。
    const anchorW = CAM_ANCHOR / ZOOM;
    const camTarget = p.x - anchorW;
    camX += (camTarget - camX) * Math.min(1, CAM_SMOOTH * dt);
    const ballPx = (p.x - camX) * ZOOM;       // ボールの画面上x(px)。画面内に保つ
    const maxPx = W * 0.84, minPx = 80;
    if (ballPx > maxPx) camX = p.x - maxPx / ZOOM;
    if (ballPx < minPx) camX = p.x - minPx / ZOOM;
  }

  // 進行距離に応じた基本前進速度（共有エンジン。ステージの speedBoost を足す）
  function runSpeedAt(x) { return Bound.runSpeedAt(P, x, scN("speedBoost", 0)); }

  function launch(c) {
    const p = player;
    p.vy = -P.BASE_VY * (1 - c * effHeightPen());
    // チャージ分はそのジャンプ限りの加速（慣性として蓄積しない）。基本速度は進行で緩やかに上昇。
    p.vx = runSpeedAt(p.x) + c * P.BOOST_MAX;
    p.onGround = false;
    // ブレイクチャージ：フルチャージで放ったジャンプ中は白壁を破壊できる
    p.breakJump = skillOn("break") && c >= 0.98;
    charge = 0;            // ジャンプしたらチャージはリセット（押しっぱなしでも）
    stopChargeTone();
    playJump(c);           // ジャンプ音（チャージが大きいほど高め）
  }

  function obstacleRight(o) {
    return o.type === "hole" ? o.x2 : o.x + o.w;
  }

  function checkCollisions() {
    const p = player;
    if (invulnT > 0) return; // リバイブ直後の無敵
    const left = p.x - PLAYER_W / 2, right = p.x + PLAYER_W / 2;
    const top = p.y - PLAYER_H, bottom = p.y;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o.color && o.color === p.ballColor) continue; // 色が一致＝すり抜け
      if (o.type === "wall") {
        const wtop = Bound.wallTop(o), wbot = Bound.wallBottom(o);
        if (right > o.x && left < o.x + o.w && bottom > wtop && top < wbot) {
          // ブレイクチャージ：フルチャージジャンプ中は白い固定壁を破壊して通過
          if (p.breakJump && o.color === COL_WHITE) {
            obstacles.splice(i, 1); i--;
            shakeT = Math.max(shakeT, 0.18);
            playBreak();
            continue;
          }
          return die(o);
        }
      } else if (o.type === "mover") {
        if (right > o.x && left < o.x + o.w) {
          const g = moverGap(o);
          if (top < g.top || bottom > g.bottom) return die(o);
        }
      }
    }
  }

  // 今チェンジ可能な色の一覧（封印された色は除外。白はスキルON時のみ）
  function allowedColors() {
    const arr = [COL_ORANGE, COL_BLACK];
    if (skillOn("white")) arr.push(COL_WHITE);
    return arr.filter(function (c) { return c !== bannedColor; });
  }

  // 自作ステージのゴール到達：クリア（dead画面を「STAGE CLEAR」として再利用）
  function clearStage() {
    if (cleared || !player.alive) return;
    cleared = true;
    player.alive = false;
    state = "dead";
    deadAt = time;
    stopChargeTone();
    bankedThisRun = starsCollected;
    starBank += starsCollected; saveBank();
    const clearM = Math.floor(customGoalX / 10);
    if (clearM > (bests[stage.id] || 0)) { bests[stage.id] = clearM; best = clearM; saveBests(); }
    playCoin();
  }

  function die(killer) {
    if (!player.alive) return;
    // チュートリアル中はゲームオーバーにせず、ゾーンの手前からやり直し
    if (tut) { tutRespawn(); return; }
    // リバイブ：1回だけ復活して続行。ミスした時点の色は以後このランで使用不可。
    if (skillOn("revive") && !reviveUsed) {
      reviveUsed = true;
      bannedColor = player.ballColor;
      const ok = allowedColors();
      player.ballColor = ok[0] || COL_BLACK;
      // ミスの原因の先へ再配置（穴なら向こう岸、壁なら壁の先）
      let nx = player.x + 60;
      if (killer) nx = (killer.type === "hole" ? killer.x2 : killer.x + killer.w) + 50;
      ensureGenerated(nx + SEG_W * 2);
      for (let k = 0; k < 200 && !landableAt(nx); k++) nx += 16; // 足場まで前進
      player.x = nx; player.y = GROUND_Y; player.vy = 0;
      player.onGround = true; player.breakJump = false;
      charge = 0; holding = false;
      invulnT = 1.2;
      shakeT = 0.25;
      stopChargeTone();
      playRevive();
      showToast("リバイブ！ " + (bannedColor === COL_ORANGE ? "オレンジ" : bannedColor === COL_BLACK ? "黒" : "白") + "は封印 / Revived!");
      return;
    }
    player.alive = false;
    state = "dead";
    deadAt = time;
    shakeT = 0.4;
    stopChargeTone();
    playDeath();
    // 集めた星を貯金へ
    bankedThisRun = starsCollected;
    starBank += starsCollected;
    saveBank();
    if (score > (bests[stage.id] || 0)) {
      bests[stage.id] = score; best = score; saveBests();
    }
  }

  // ---------------------------------------------------------------------------
  // サウンド（Web Audio）
  // ---------------------------------------------------------------------------
  let actx = null;
  let chargeOsc = null, chargeGain = null;

  function ensureAudio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { actx = null; }
    }
    if (actx && actx.state === "suspended") actx.resume();
  }

  function startChargeTone() {
    if (!actx || chargeOsc) return;
    chargeOsc = actx.createOscillator();
    chargeGain = actx.createGain();
    chargeOsc.type = "triangle";
    chargeOsc.frequency.value = 220;
    chargeGain.gain.value = 0.0001;
    chargeGain.gain.linearRampToValueAtTime(0.10, actx.currentTime + 0.03);
    chargeOsc.connect(chargeGain).connect(actx.destination);
    chargeOsc.start();
  }
  function updateChargeTone(c) {
    if (!actx || !chargeOsc) return;
    // チャージが進むほど高い音階へ（約2オクターブ上昇）
    const f = 220 * Math.pow(2, c * 2);
    chargeOsc.frequency.setTargetAtTime(f, actx.currentTime, 0.02);
  }
  function stopChargeTone() {
    if (!actx || !chargeOsc) return;
    const o = chargeOsc, g = chargeGain;
    g.gain.cancelScheduledValues(actx.currentTime);
    g.gain.setTargetAtTime(0.0001, actx.currentTime, 0.03);
    o.stop(actx.currentTime + 0.12);
    chargeOsc = null; chargeGain = null;
  }
  function playSwitch() {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "triangle";
    const base = player.ballColor === COL_BLACK ? 300 : 520; // 色で音程を変える
    o.frequency.setValueAtTime(base, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(base * 1.5, actx.currentTime + 0.07);
    g.gain.setValueAtTime(0.12, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.1);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.12);
  }
  function playJump(c) {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "square";
    const base = 330 + c * 260;                // チャージが大きいほど高い
    o.frequency.setValueAtTime(base, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(base * 1.7, actx.currentTime + 0.10);
    g.gain.setValueAtTime(0.16, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.16);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.18);
  }
  function playLand() {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(190, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(70, actx.currentTime + 0.11);
    g.gain.setValueAtTime(0.2, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.16);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.18);
  }
  function playDeath() {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(420, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(80, actx.currentTime + 0.4);
    g.gain.setValueAtTime(0.18, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.45);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.5);
  }
  function playCoin() {
    if (!actx) return;
    // 明るい2音のチャイム（取得の気持ちよさ）
    var t0 = actx.currentTime;
    [988, 1319].forEach(function (f, i) {
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(f, t0 + i * 0.05);
      g.gain.setValueAtTime(0.0001, t0 + i * 0.05);
      g.gain.linearRampToValueAtTime(0.16, t0 + i * 0.05 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.05 + 0.16);
      o.connect(g).connect(actx.destination);
      o.start(t0 + i * 0.05); o.stop(t0 + i * 0.05 + 0.18);
    });
  }

  function playBreak() {
    if (!actx) return;
    // 白壁粉砕：ノイズ風の短い破裂音
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(160, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, actx.currentTime + 0.18);
    g.gain.setValueAtTime(0.22, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.2);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.22);
    const o2 = actx.createOscillator(), g2 = actx.createGain();
    o2.type = "square";
    o2.frequency.setValueAtTime(880, actx.currentTime);
    o2.frequency.exponentialRampToValueAtTime(220, actx.currentTime + 0.08);
    g2.gain.setValueAtTime(0.10, actx.currentTime);
    g2.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.1);
    o2.connect(g2).connect(actx.destination);
    o2.start(); o2.stop(actx.currentTime + 0.12);
  }
  function playRevive() {
    if (!actx) return;
    // 復活：上昇する3音
    const t0 = actx.currentTime;
    [392, 523, 784].forEach(function (f, i) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(f, t0 + i * 0.09);
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      g.gain.linearRampToValueAtTime(0.16, t0 + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.09 + 0.22);
      o.connect(g).connect(actx.destination);
      o.start(t0 + i * 0.09); o.stop(t0 + i * 0.09 + 0.25);
    });
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------
  function draw() {
    ctx.clearRect(0, 0, W, H);

    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#f6e1ac");
    sky.addColorStop(0.6, "#efd293");
    sky.addColorStop(1, "#e7c07a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // タイトル中はカメラを固定基準に
    const cam = state === "title" ? (player.x - CAM_ANCHOR / ZOOM) : camX;
    drawParallax(cam);

    let sx = 0, sy = 0;
    if (shakeT > 0) { sx = (Math.random() - 0.5) * 10; sy = (Math.random() - 0.5) * 10; }
    ctx.save();
    // 地面ラインを基準にズームアウトしてワールドを描画（引きで先まで見える）
    ctx.translate(sx, GROUND_SCREEN_Y + sy);
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-cam, -GROUND_Y);

    drawGround(cam);
    drawObstacles(cam);
    drawItems(cam);
    if (tut && state === "play") drawTutMarker();
    drawPlayer();

    ctx.restore();

    drawHUD();
    if (tut && state === "play") drawTutorial();
    if (state === "title")  drawTitle();
    if (state === "skills") drawSkills();
    if (state === "dead")   drawDead();
    if (state === "play" && paused) drawPause();

    // 一時メッセージ（共有時のフィードバックなど）
    if (performance.now() < toastUntil) {
      ctx.textAlign = "center";
      ctx.font = "bold 16px sans-serif";
      const tw = ctx.measureText(toastMsg).width + 36;
      ctx.fillStyle = "rgba(20,30,50,0.88)";
      roundRect(W / 2 - tw / 2, H - 96, tw, 34, 9); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(toastMsg, W / 2, H - 74);
      ctx.textAlign = "left";
    }
  }

  function drawParallax(camX) {
    ctx.save();
    // 観客席／壁を思わせる、暖色のぼんやりした帯
    ctx.fillStyle = "rgba(196,150,86,0.30)";
    const off1 = -(camX * 0.2) % 300;
    for (let i = -1; i < W / 300 + 2; i++) {
      const bx = off1 + i * 300;
      ctx.beginPath(); ctx.arc(bx + 150, H, 200, Math.PI, 0); ctx.fill();
    }
    ctx.fillStyle = "rgba(170,124,66,0.34)";
    const off2 = -(camX * 0.45) % 220;
    for (let i = -1; i < W / 220 + 2; i++) {
      const bx = off2 + i * 220;
      ctx.beginPath(); ctx.arc(bx + 110, H + 40, 150, Math.PI, 0); ctx.fill();
    }
    ctx.restore();
  }

  // 地面・障害物・スター・ボール・角丸は共有エンジンに委譲（描画は engine.js に一本化）
  function drawGround(camX)   { Bound.drawGround(ctx, obstacles, camX, ZOOM, player.ballColor); }
  function drawObstacles(camX){ Bound.drawObstacles(ctx, obstacles, camX, ZOOM, time, player.ballColor); }
  function drawItems(camX)    { Bound.drawItems(ctx, items, camX, ZOOM, time); }
  function roundRect(x, y, w, h, r) { Bound.roundRect(ctx, x, y, w, h, r); }
  function drawPlayer() {
    const blink = invulnT > 0 && (time * 10) % 2 < 1; // リバイブ直後は点滅（無敵の合図）
    Bound.drawBall(ctx, player, charge, time,
      { alive: player.alive, breakJump: player.breakJump, blink: blink });
  }

  function drawHUD() {
    ctx.fillStyle = "#3a2710";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("DISTANCE " + score + " m", 20, 38);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "#7a6033";
    ctx.fillText("BEST " + best + " m", 22, 60);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText("★ " + starsCollected, 22, 84);

    if (state === "play" || state === "dead") {
      // ステージ名
      ctx.fillStyle = "#7a6033";
      ctx.font = "13px sans-serif";
      ctx.fillText(stage.name + " / " + stage.en, 22, 104);
      // リバイブ残機
      if (skillOn("revive")) {
        ctx.font = "bold 15px sans-serif";
        ctx.fillStyle = reviveUsed ? "rgba(120,90,40,0.35)" : "#d04a3a";
        ctx.fillText(reviveUsed ? "♡" : "♥ REVIVE", 22, 126);
      }
      // 封印された色
      if (bannedColor) {
        ctx.fillStyle = "#8a2f1f";
        ctx.font = "bold 13px sans-serif";
        ctx.fillText("封印: " + (bannedColor === COL_ORANGE ? "オレンジ" : bannedColor === COL_BLACK ? "黒" : "白") +
                     " / Sealed", 22, 146);
      }
    }

    if (state === "play") {
      drawPauseButton();

      const mw = 180, mh = 14, mx = W - mw - 64, my = 28;
      const airborneDisabled = holding && !player.nearGround;
      ctx.fillStyle = "rgba(60,40,16,0.18)";
      roundRect(mx, my, mw, mh, 7); ctx.fill();
      if (!airborneDisabled) {
        const grd = ctx.createLinearGradient(mx, 0, mx + mw, 0);
        grd.addColorStop(0, "#5ad6c0");
        grd.addColorStop(1, "#78dcff");
        ctx.fillStyle = grd;
        roundRect(mx, my, mw * charge, mh, 7); ctx.fill();
      }
      ctx.fillStyle = airborneDisabled ? "#9a8048" : "#6b5126";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(airborneDisabled ? "Charge" : "Charge", mx - 8, my + 12);
      ctx.textAlign = "left";
    }
  }

  function drawPauseButton() {
    const b = PAUSE_BTN;
    ctx.fillStyle = "rgba(58,39,16,0.18)";
    roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill();
    ctx.fillStyle = "#3a2710";
    if (!paused) {
      ctx.fillRect(b.x + 11, b.y + 10, 5, 18); // ❙❙ 一時停止
      ctx.fillRect(b.x + 22, b.y + 10, 5, 18);
    } else {
      ctx.beginPath();                         // ▶ 再生
      ctx.moveTo(b.x + 13, b.y + 9);
      ctx.lineTo(b.x + 13, b.y + 29);
      ctx.lineTo(b.x + 29, b.y + 19);
      ctx.closePath(); ctx.fill();
    }
  }

  // チュートリアル：対象障害物の上で跳ねる「▼」マーカー（ワールド座標で描画）
  function drawTutMarker() {
    const z = TUT_ZONES[tutZoneIdx()];
    if (z.mark < 0 || player.x > z.mark) return;
    const bob = Math.sin(time * 5) * 8;
    const my = GROUND_Y - 320 + bob;
    ctx.fillStyle = "rgba(208,74,58,0.95)";
    ctx.beginPath();
    ctx.moveTo(z.mark - 16, my);
    ctx.lineTo(z.mark + 16, my);
    ctx.lineTo(z.mark, my + 26);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // チュートリアル：上部のガイドバナーとスキップボタン（スクリーン座標で描画）
  function drawTutorial() {
    const zi = tutZoneIdx();
    const z = TUT_ZONES[zi];
    const done = tut.doneAt >= 0;

    // ガイドバナー
    const bw = 760, bx = (W - bw) / 2, by = 64;
    ctx.fillStyle = "rgba(20,30,50,0.82)";
    roundRect(bx, by, bw, 72, 12); ctx.fill();
    ctx.strokeStyle = done ? "#5ad6c0" : "#78dcff";
    ctx.lineWidth = 2;
    roundRect(bx, by, bw, 72, 12); ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#9fd8ff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(done ? "TUTORIAL COMPLETE!" : "TUTORIAL  " + Math.min(zi + 1, 4) + " / 4", W / 2, by + 18);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(done ? "チュートリアル完了！" : z.jp, W / 2, by + 41);
    ctx.fillStyle = "#a7adda";
    ctx.font = "12px sans-serif";
    ctx.fillText(done ? "Tutorial complete!" : z.en, W / 2, by + 60);
    ctx.textAlign = "left";

    // スキップボタン（ポーズボタンの左）
    const b = TUT_SKIP_BTN;
    ctx.fillStyle = "rgba(58,39,16,0.18)";
    roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill();
    ctx.fillStyle = "#3a2710";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("スキップ/Skip", b.x + b.w / 2, b.y + 24);
    ctx.textAlign = "left";
  }

  function drawPause() {
    overlay();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 46px sans-serif";
    ctx.fillText("PAUSED", W / 2, H / 2 - 6);
    ctx.fillStyle = "#c8cdf0";
    ctx.font = "18px sans-serif";
    ctx.fillText("⏸ ボタン / P / Esc で再開  |  Tap ⏸ / P / Esc to resume", W / 2, H / 2 + 34);
    ctx.textAlign = "left";
  }

  function drawTitle() {
    overlay();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 44px sans-serif";
    ctx.fillText("Bound", W / 2, 72);
    ctx.fillStyle = "#a7adda";
    ctx.font = "13px sans-serif";
    ctx.fillText("地上で長押しチャージ／空中タップで色チェンジ・同色すり抜け", W / 2, 100);
    ctx.fillText("Hold to charge on ground / Tap mid-air to switch color & phase", W / 2, 118);

    // 星の貯金（右上）
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffd23a";
    ctx.font = "bold 22px sans-serif";
    ctx.fillText("★ " + starBank, W - 24, 44);

    // チュートリアル再生（左上）
    const tb = TUT_BTN;
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    roundRect(tb.x, tb.y, tb.w, tb.h, 9); ctx.fill();
    ctx.fillStyle = "#c8cdf0";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("？ チュートリアル / Tutorial", tb.x + tb.w / 2, tb.y + 23);

    // ステージカード（3×2）
    ctx.textAlign = "center";
    ctx.fillStyle = "#dfe4ff";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText("STAGE SELECT", W / 2, CARD_Y0 - 14);
    for (let i = 0; i < STAGES.length; i++) {
      const st = STAGES[i], r = stageCardRect(i);
      const unlocked = stageUnlocked(st);
      const sel = (i === stageSel);
      ctx.fillStyle = unlocked ? (sel ? "rgba(90,180,255,0.30)" : "rgba(255,255,255,0.10)")
                               : "rgba(255,255,255,0.04)";
      roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill();
      if (sel) {
        ctx.strokeStyle = ((time * 2.5) % 2 < 1) ? "#78dcff" : "#5ad6c0";
        ctx.lineWidth = 3;
        roundRect(r.x, r.y, r.w, r.h, 10); ctx.stroke();
      }
      const cx = r.x + r.w / 2;
      if (unlocked) {
        ctx.fillStyle = "#fff";
        ctx.font = "bold 18px sans-serif";
        ctx.fillText(st.name, cx, r.y + 28);
        ctx.fillStyle = "#a7adda";
        ctx.font = "12px sans-serif";
        ctx.fillText(st.en + "  /  BEST " + (bests[st.id] || 0) + " m", cx, r.y + 48);
        ctx.fillStyle = "#8d94c4";
        ctx.font = "11px sans-serif";
        ctx.fillText(st.hint, cx, r.y + 70);
      } else {
        ctx.fillStyle = "#7a7f9f";
        ctx.font = "bold 18px sans-serif";
        ctx.fillText("🔒 " + st.name, cx, r.y + 32);
        ctx.fillStyle = "#666b8a";
        ctx.font = "12px sans-serif";
        ctx.fillText("要スキル：" + reqNames(st, "name"), cx, r.y + 54);
        ctx.fillText("Needs: " + reqNames(st, "en"), cx, r.y + 70);
      }
    }

    // スキルショップボタン
    const sb = SKILLS_BTN;
    ctx.fillStyle = "rgba(255,210,58,0.18)";
    roundRect(sb.x, sb.y, sb.w, sb.h, 10); ctx.fill();
    ctx.strokeStyle = "#ffd23a"; ctx.lineWidth = 2;
    roundRect(sb.x, sb.y, sb.w, sb.h, 10); ctx.stroke();
    ctx.fillStyle = "#ffe79a";
    ctx.font = "bold 17px sans-serif";
    ctx.fillText("★ スキル / Skills (S)", W / 2, sb.y + 28);

    ctx.fillStyle = ((time * 2) % 2 < 1) ? "#78dcff" : "#5ad6c0";
    ctx.font = "bold 19px sans-serif";
    ctx.fillText("▶ スペース or 選択カードをタップでスタート / Space or tap card to start", W / 2, 472);
    ctx.fillStyle = "#8d94c4";
    ctx.font = "12px sans-serif";
    ctx.fillText("←→↑↓ でステージ選択 / Arrow keys to select", W / 2, 494);
    ctx.textAlign = "left";
  }

  // スキルショップ画面
  function drawSkills() {
    overlay();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("SKILLS", W / 2, 56);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffd23a";
    ctx.font = "bold 22px sans-serif";
    ctx.fillText("★ " + starBank, W - 24, 44);

    // 戻るボタン
    const bb = BACK_BTN;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRect(bb.x, bb.y, bb.w, bb.h, 9); ctx.fill();
    ctx.fillStyle = "#dfe4ff";
    ctx.font = "bold 15px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("← 戻る/Back", bb.x + bb.w / 2, bb.y + 25);

    ctx.fillStyle = "#a7adda";
    ctx.font = "12px sans-serif";
    ctx.fillText("タップで購入。所持スキルはタップで ON / OFF　|　Tap to buy; tap owned skills to toggle", W / 2, 96);

    for (let i = 0; i < SKILLS.length; i++) {
      const sk = SKILLS[i], r = skillRowRect(i);
      const own = hasSkill(sk.id), on = skillOn(sk.id);
      const afford = starBank >= sk.cost;
      ctx.fillStyle = own ? (on ? "rgba(90,214,192,0.22)" : "rgba(255,255,255,0.07)")
                          : (afford ? "rgba(255,210,58,0.13)" : "rgba(255,255,255,0.045)");
      roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill();
      if (own && on) {
        ctx.strokeStyle = "#5ad6c0"; ctx.lineWidth = 2;
        roundRect(r.x, r.y, r.w, r.h, 10); ctx.stroke();
      }
      ctx.textAlign = "left";
      ctx.fillStyle = own ? "#fff" : (afford ? "#ffe79a" : "#8d94c4");
      ctx.font = "bold 17px sans-serif";
      ctx.fillText(sk.name + "  /  " + sk.en, r.x + 16, r.y + 24);
      ctx.fillStyle = own ? "#a9d8cf" : "#8d94c4";
      ctx.font = "12px sans-serif";
      ctx.fillText(sk.desc + "  |  " + sk.en2, r.x + 16, r.y + 44);
      ctx.textAlign = "right";
      if (own) {
        ctx.fillStyle = on ? "#5ad6c0" : "#7a7f9f";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText(on ? "ON" : "OFF", r.x + r.w - 18, r.y + 35);
      } else {
        ctx.fillStyle = afford ? "#ffd23a" : "#7a7f9f";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("★ " + sk.cost, r.x + r.w - 18, r.y + 35);
      }
    }
    ctx.textAlign = "left";
  }

  function drawDead() {
    overlay();
    ctx.textAlign = "center";
    if (cleared) {
      ctx.fillStyle = "#5ad6c0";
      ctx.font = "bold 48px sans-serif";
      ctx.fillText("STAGE CLEAR", W / 2, H / 2 - 40);
    } else {
      ctx.fillStyle = "#ff7080";
      ctx.font = "bold 48px sans-serif";
      ctx.fillText("GAME OVER", W / 2, H / 2 - 40);
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("DISTANCE " + score + " m", W / 2, H / 2 + 14);
    ctx.fillStyle = "#c8cdf0";
    ctx.font = "18px sans-serif";
    ctx.fillText("BEST " + best + " m", W / 2, H / 2 + 44);
    ctx.fillStyle = "#ffd23a";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText("★ +" + bankedThisRun + "  Total Bank " + starBank, W / 2, H / 2 + 72);
    if (time - deadAt > 0.4) {
      ctx.fillStyle = ((time * 2) % 2 < 1) ? "#78dcff" : "#5ad6c0";
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("▶ スペース / タップ でリトライ  |  Space / Tap to retry", W / 2, H / 2 + 98);

      // SNS シェアボタン
      const b = SHARE_BTN;
      ctx.fillStyle = "rgba(90,180,255,0.22)";
      roundRect(b.x, b.y, b.w, b.h, 12); ctx.fill();
      ctx.strokeStyle = "#78dcff"; ctx.lineWidth = 2;
      roundRect(b.x, b.y, b.w, b.h, 12); ctx.stroke();
      ctx.fillStyle = "#e6f6ff"; ctx.font = "bold 18px sans-serif";
      ctx.fillText("結果をシェア / Share", W / 2, b.y + 29);

      // メニューへ戻る
      const m = MENU_BTN;
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      roundRect(m.x, m.y, m.w, m.h, 10); ctx.fill();
      ctx.fillStyle = "#dfe4ff"; ctx.font = "bold 16px sans-serif";
      ctx.fillText("メニュー / Menu", W / 2, m.y + 26);
    }
    ctx.textAlign = "left";
  }

  function overlay() {
    ctx.fillStyle = "rgba(10,12,28,0.6)";
    ctx.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------------------
  // メインループ（固定タイムステップ）
  // ---------------------------------------------------------------------------
  let lastT = performance.now();
  let acc = 0;
  const STEP = 1 / 120;

  function loop(now) {
    let frame = (now - lastT) / 1000;
    lastT = now;
    if (frame > 0.25) frame = 0.25;
    acc += frame;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    draw();
    requestAnimationFrame(loop);
  }

  reset();
  requestAnimationFrame(loop);
})();