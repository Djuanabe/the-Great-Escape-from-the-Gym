"use strict";
/* =============================================================================
 * Bound — 共有エンジン (engine.js)
 *   ゲーム本編 (game.js) と ステージエディタ (editor.js) が共有する、
 *   依存なしのプレーンな名前空間 `window.Bound`。
 *
 *   - 定数：地形・描画・物理の既定値（両者で一致させるべき値）
 *   - 純粋関数：物理の素（軌道速度・移動壁ギャップ・地形クエリ）
 *   - 描画プリミティブ：地面/穴/浮島/障害物/スター/ボール（zoomはすべて引数）
 *
 *   物理の数式・描画はここに一本化されているため、エディタの試遊は本編と必ず一致する。
 * ============================================================================= */
(function (global) {
  // 論理キャンバスサイズ（本編・エディタとも 960×540 固定）
  const VIEW_W = 960, VIEW_H = 540;

  // --- 物理・地形・描画の共有定数 -------------------------------------------
  const GROUND_Y = 430;          // 地面の高さ（プレイヤーの足の基準）
  const CHARGE_MAX = 1.0;        // チャージ上限（超えると自動解放）
  const NEAR_GROUND_H = 90;      // この高さ以内（降下中）ならチャージ可能(px)
  const CAM_ANCHOR = 130;        // ボールの画面上の基準x(px)
  const CAM_SMOOTH = 6;          // カメラ追従の滑らかさ
  const ZOOM = 0.74;             // 本編の引き（エディタは独自のzoom変数を使う）
  const GROUND_SCREEN_Y = 440;   // 地面ラインの画面上の高さ(px)
  const PLAYER_W = 26, PLAYER_H = 32;
  const FALL_ALLOW = 16;         // 地面を超えて落ちてもセーフな余地(px)
  const DEATH_Y = GROUND_Y + FALL_ALLOW;
  const HOLE_GRACE = 14;         // 穴の落下判定を見た目より両端で狭める余地(px)
  const TILE = 48;               // 床板の幅
  const ISLAND_H = 26;           // 浮島の厚み（描画用, px）
  const ITEM_R = 9;              // スターの見た目半径(px)
  const ITEM_COLLECT_R = 34;     // スター取得判定の半径
  const BALL_R = 16;             // ボールの半径

  // ボールの色。色が一致した壁はすり抜け可。白は中立（オレンジ/黒では必ず衝突）。
  const COL_ORANGE = "orange", COL_BLACK = "black", COL_WHITE = "white";
  const PALETTE = {
    orange: { main: "#df6f17", light: "#ffae5c", seam: "#1b1206" },
    black:  { main: "#2b2b30", light: "#5d5d66", seam: "#e8e8f0" },
    white:  { main: "#eceef3", light: "#ffffff", seam: "#3a2a14" }
  };

  // 既定の物理パラメータ（自作ステージはこれを phys で上書きできる）
  const PHYS_BASE = {
    G: 3200,            // 重力 (px/s^2)。滞空時間≒0.575秒
    BASE_VY: 920,       // 通常ジャンプの初速（上向き）
    BASE_VX: 340,       // 開始時の基本前進速度
    BOOST_MAX: 330,     // チャージ解放時のそのジャンプ限りの前進加速
    HEIGHT_PEN: 0.45,   // 最大チャージ時の高度低下率
    CHARGE_TIME: 0.72,  // フルチャージまでの時間(秒)
    SPEED_ACCEL: 0.02,  // 進行距離あたりの加速 (px/s / px)
    SPEED_EXTRA_MAX: 520// 進行による加速の上限(px/s)
  };

  // --- 純粋関数：乱数・幾何 --------------------------------------------------
  // シード付き乱数（再現可能なステージ生成用）
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 移動壁の現在の隙間（上端・下端）。time でアニメする。
  function moverGap(o, time) {
    const center = o.center + o.ampl * Math.sin(o.phase + time * o.speed);
    return { top: center - o.gapH / 2, bottom: center + o.gapH / 2 };
  }

  // 壁の上端・下端。o.y があれば空中の壁（[y, y+h]）、なければ地面接地（[GROUND_Y-h, GROUND_Y]）。
  function wallTop(o)    { return (o.y != null) ? o.y : GROUND_Y - o.h; }
  function wallBottom(o) { return (o.y != null) ? o.y + o.h : GROUND_Y; }

  // --- 純粋関数：物理 --------------------------------------------------------
  // 進行距離に応じた基本前進速度（等加速度的に上昇、上限あり）。extraBoost はステージ補正。
  function runSpeedAt(P, x, extraBoost) {
    return P.BASE_VX + (extraBoost || 0) + Math.min(P.SPEED_EXTRA_MAX, x * P.SPEED_ACCEL);
  }

  // --- 純粋関数：地形クエリ --------------------------------------------------
  // x の真下が穴か（落下判定は見た目より両端を HOLE_GRACE 狭める）
  function holeAt(obstacles, x) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o.type === "hole" && x >= o.x1 + HOLE_GRACE && x <= o.x2 - HOLE_GRACE) return o;
    }
    return null;
  }

  // x に着地できる足場があるか（通常地面 or 色違いの浮島）
  function landableAt(obstacles, x, ballColor) {
    const h = holeAt(obstacles, x);
    if (!h) return true;                       // 通常の地面
    const isl = h.island;
    if (isl && x >= isl.x1 - HOLE_GRACE && x <= isl.x2 + HOLE_GRACE
        && isl.color !== ballColor) {          // 色違いの浮島＝足場
      return true;
    }
    return false;                              // 穴（または同色で通り抜ける浮島）
  }

  // --- 描画プリミティブ（呼び出し側でワールド変換を設定済みの前提） ----------
  function fillGroundBlock(ctx, a, b) {
    // バスケットコートの木目フロア
    ctx.fillStyle = "#c89a5b";
    ctx.fillRect(a, GROUND_Y, b - a, VIEW_H - GROUND_Y + 60);
    ctx.save();
    ctx.beginPath(); ctx.rect(a, GROUND_Y, b - a, VIEW_H - GROUND_Y + 60); ctx.clip();
    const t0 = Math.floor(a / TILE) * TILE;
    for (let tx = t0; tx < b; tx += TILE) {
      ctx.fillStyle = (Math.floor(tx / TILE) & 1) ? "#c0934f" : "#cea466";
      ctx.fillRect(tx, GROUND_Y + 10, TILE, 999);
      ctx.fillStyle = "rgba(120,80,30,0.45)";
      ctx.fillRect(tx, GROUND_Y, 2, VIEW_H - GROUND_Y + 60);
    }
    ctx.restore();
    // 上端のコートライン（白）
    ctx.fillStyle = "#caa066";
    ctx.fillRect(a, GROUND_Y, b - a, 8);
    ctx.fillStyle = "#f7eedd";
    ctx.fillRect(a, GROUND_Y, b - a, 3);
  }

  function drawIsland(ctx, isl, ballColor) {
    const pal = PALETTE[isl.color] || PALETTE.orange;
    const matched = (isl.color === ballColor); // 同色＝足場にならず通り抜ける
    const w = isl.x2 - isl.x1;
    ctx.save();
    ctx.globalAlpha = matched ? 0.28 : 1.0; // 同色なら半透明（乗れない合図）
    ctx.fillStyle = pal.main;
    ctx.fillRect(isl.x1, GROUND_Y, w, ISLAND_H);
    ctx.fillStyle = pal.light;
    ctx.fillRect(isl.x1, GROUND_Y, w, 5);
    ctx.globalAlpha = matched ? 0.4 : 1.0;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(isl.x1, GROUND_Y, w, ISLAND_H);
    ctx.restore();
  }

  function drawHole(ctx, h, ballColor) {
    const grd = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y + 70);
    grd.addColorStop(0, "rgba(40,24,8,0.55)");
    grd.addColorStop(1, "rgba(40,24,8,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(h.x1, GROUND_Y, h.x2 - h.x1, 70);
    ctx.fillStyle = "#b5371f";
    ctx.fillRect(h.x1 - 5, GROUND_Y, 5, 34);
    ctx.fillRect(h.x2, GROUND_Y, 5, 34);
    ctx.fillStyle = "#3a2410";
    ctx.fillRect(h.x1 - 5, GROUND_Y, 5, 4);
    ctx.fillRect(h.x2, GROUND_Y, 5, 4);
    if (h.island) drawIsland(ctx, h.island, ballColor);
  }

  // 地面（穴で分割して描画）。camX=画面左端ワールドx, zoom=表示倍率。
  function drawGround(ctx, obstacles, camX, zoom, ballColor) {
    const x0 = camX - 40, x1 = camX + VIEW_W / zoom + 40;
    const holes = obstacles
      .filter(o => o.type === "hole" && o.x2 > x0 && o.x1 < x1)
      .sort((a, b) => a.x1 - b.x1);
    let cursor = x0;
    for (const h of holes) {
      if (h.x1 > cursor) fillGroundBlock(ctx, cursor, h.x1);
      cursor = Math.max(cursor, h.x2);
    }
    if (cursor < x1) fillGroundBlock(ctx, cursor, x1);
    for (const h of holes) drawHole(ctx, h, ballColor);
  }

  // 壁・移動壁（穴以外）。色一致中は半透明（すり抜けの合図）。
  function drawObstacles(ctx, obstacles, camX, zoom, time, ballColor) {
    const x0 = camX - 60, x1 = camX + VIEW_W / zoom + 60;
    for (const o of obstacles) {
      if (o.type === "hole") continue;
      if (o.x + o.w < x0 || o.x > x1) continue;
      const pal = PALETTE[o.color] || PALETTE.orange;
      const matched = (o.color === ballColor);
      ctx.save();
      ctx.globalAlpha = matched ? 0.28 : 1.0;
      if (o.type === "wall") {
        const wtop = wallTop(o);
        ctx.fillStyle = pal.main;
        ctx.fillRect(o.x, wtop, o.w, o.h);
        ctx.fillStyle = pal.light;
        ctx.fillRect(o.x, wtop, o.w, 6);
        ctx.globalAlpha = matched ? 0.4 : 1.0;
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, wtop, o.w, o.h);
      } else if (o.type === "mover") {
        const g = moverGap(o, time);
        ctx.fillStyle = pal.main;
        if (g.top > 0) ctx.fillRect(o.x, -20, o.w, g.top + 20);
        ctx.fillRect(o.x, g.bottom, o.w, GROUND_Y - g.bottom);
        ctx.fillStyle = pal.light;
        ctx.fillRect(o.x, g.top - 5, o.w, 5);
        ctx.fillRect(o.x, g.bottom, o.w, 5);
      }
      ctx.restore();
    }
  }

  // 道しるべスター（黒い星＋白縁取り）。time で脈動・回転。
  function drawItems(ctx, items, camX, zoom, time) {
    const x0 = camX - 40, x1 = camX + VIEW_W / zoom + 40;
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    for (const it of items) {
      if (it.x < x0 || it.x > x1) continue;
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.fillStyle = "rgba(0, 0, 0, " + (0.12 + 0.10 * pulse) + ")";
      ctx.beginPath();
      ctx.arc(0, 0, ITEM_R * (1.9 + 0.4 * pulse), 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(time * 1.5);
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const ang = Math.PI / 5 * k - Math.PI / 2;
        const r = (k % 2 === 0) ? ITEM_R : ITEM_R * 0.45;
        const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "#111111";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.stroke();
      ctx.restore();
    }
  }

  // ボール本体（影・各種オーラ・回転スクワッシュ・継ぎ目）。
  // opts: { alive=true, breakJump=false, blink=false } blink時は描画スキップ（無敵点滅）。
  function drawBall(ctx, p, charge, time, opts) {
    opts = opts || {};
    if (opts.blink) return;
    // 接地影
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(p.x, GROUND_Y + 2, BALL_R * 0.9, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // ブレイクチャージ中（白壁破壊可能）は赤いオーラ
    if (opts.breakJump) {
      ctx.fillStyle = "rgba(255,90,60," + (0.35 + 0.2 * Math.sin(time * 14)) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y - BALL_R, BALL_R * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // チャージのグロー
    if (charge > 0) {
      ctx.fillStyle = "rgba(120,220,255," + (0.3 + charge * 0.5) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y - BALL_R, BALL_R * (1.25 + charge * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    // 転がり回転＋接地時スクワッシュ
    const rot = p.x * 0.02;
    const sx = p.onGround ? 1.14 : 1.0;
    const sy = p.onGround ? 0.86 : 1.0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(sx, sy);
    ctx.translate(0, -BALL_R);
    ctx.rotate(rot);
    const pal = PALETTE[p.ballColor] || PALETTE.orange;
    if (opts.alive === false) {
      ctx.fillStyle = "#8a8a8a";
    } else {
      const g = ctx.createRadialGradient(-BALL_R * 0.35, -BALL_R * 0.35, BALL_R * 0.2, 0, 0, BALL_R);
      g.addColorStop(0, pal.light);
      g.addColorStop(1, pal.main);
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    // 継ぎ目
    ctx.strokeStyle = pal.seam;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(-BALL_R, 0); ctx.lineTo(BALL_R, 0);
    ctx.moveTo(0, -BALL_R); ctx.lineTo(0, BALL_R);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -BALL_R); ctx.quadraticCurveTo(-BALL_R * 0.78, 0, 0, BALL_R);
    ctx.moveTo(0, -BALL_R); ctx.quadraticCurveTo(BALL_R * 0.78, 0, 0, BALL_R);
    ctx.stroke();
    ctx.restore();
  }

  global.Bound = {
    // 定数
    VIEW_W: VIEW_W, VIEW_H: VIEW_H,
    GROUND_Y: GROUND_Y, CHARGE_MAX: CHARGE_MAX, NEAR_GROUND_H: NEAR_GROUND_H,
    CAM_ANCHOR: CAM_ANCHOR, CAM_SMOOTH: CAM_SMOOTH, ZOOM: ZOOM, GROUND_SCREEN_Y: GROUND_SCREEN_Y,
    PLAYER_W: PLAYER_W, PLAYER_H: PLAYER_H, FALL_ALLOW: FALL_ALLOW, DEATH_Y: DEATH_Y,
    HOLE_GRACE: HOLE_GRACE, TILE: TILE, ISLAND_H: ISLAND_H,
    ITEM_R: ITEM_R, ITEM_COLLECT_R: ITEM_COLLECT_R, BALL_R: BALL_R,
    COL_ORANGE: COL_ORANGE, COL_BLACK: COL_BLACK, COL_WHITE: COL_WHITE, PALETTE: PALETTE,
    PHYS_BASE: PHYS_BASE,
    // 純粋関数
    mulberry32: mulberry32, roundRect: roundRect, moverGap: moverGap,
    wallTop: wallTop, wallBottom: wallBottom,
    runSpeedAt: runSpeedAt, holeAt: holeAt, landableAt: landableAt,
    // 描画プリミティブ
    fillGroundBlock: fillGroundBlock, drawIsland: drawIsland, drawHole: drawHole,
    drawGround: drawGround, drawObstacles: drawObstacles, drawItems: drawItems, drawBall: drawBall
  };
})(typeof window !== "undefined" ? window : this);
