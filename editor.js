"use strict";
(function () {
  // =========================================================================
  // 共有エンジン（engine.js）の定数・物理・描画プリミティブを利用
  // =========================================================================
  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const DPR = window.devicePixelRatio || 1;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + "px"; cv.style.height = H + "px";
  ctx.scale(DPR, DPR);

  const {
    GROUND_Y, CHARGE_MAX, NEAR_GROUND_H, GROUND_SCREEN_Y, CAM_ANCHOR, CAM_SMOOTH,
    PLAYER_W, PLAYER_H, DEATH_Y, ISLAND_H, BALL_R, ITEM_R, ITEM_COLLECT_R,
    COL_ORANGE, COL_BLACK, COL_WHITE, PALETTE
  } = Bound;
  const PHYS_DEFAULT = Bound.PHYS_BASE; // 既定の物理（newStage 等で複製して使う）

  // =========================================================================
  // ステージデータ
  //   obstacles: [{type:"hole",x1,x2,island?},{type:"wall",x,w,h,color},
  //               {type:"mover",x,w,center,ampl,gapH,phase,speed,color}]
  //   items:     [{x,y}]
  //   phys/meta はUIと同期
  // =========================================================================
  let stage = newStage();
  function newStage() {
    return {
      meta: { name: "新ステージ", en: "New Stage", hint: "", req: [] }, // req: 解放に必要なスキルID配列（全て必要）
      phys: Object.assign({}, PHYS_DEFAULT),
      length: 6000,
      obstacles: [],
      items: []
    };
  }

  // =========================================================================
  // 座標変換（index.html と同じ）。cam=画面左端のワールドx, zoom=表示倍率
  // =========================================================================
  let cam = 0;
  let zoom = 0.74;
  function worldToScreen(wx, wy) {
    return { x: (wx - cam) * zoom, y: (wy - GROUND_Y) * zoom + GROUND_SCREEN_Y };
  }
  function screenToWorld(sx, sy) {
    return { x: sx / zoom + cam, y: (sy - GROUND_SCREEN_Y) / zoom + GROUND_Y };
  }

  // =========================================================================
  // 編集状態
  // =========================================================================
  let tool = "select";
  let selected = null;     // 選択中のオブジェクト参照
  let dragging = null;     // {obj, type, offX, offY} ドラッグ中
  let panning = null;      // {startSX, startCam}
  let mode = "edit";       // "edit" | "play" | "dead"（試遊中にミス＝一時停止）
  let edTime = 0;          // 編集プレビュー用の時間（移動壁アニメ）
  let trajectory = [];     // 試遊中のボール軌道（{x,y}）。死亡/停止時に表示
  let lastTrajectory = []; // 直前の試遊の軌道（編集に戻っても残す）

  // =========================================================================
  // ジオメトリ・ヒットテスト
  // =========================================================================
  function obstBounds(o) {
    if (o.type === "hole") return { x: o.x1, y: GROUND_Y, w: o.x2 - o.x1, h: 70 };
    if (o.type === "wall") return { x: o.x, y: Bound.wallTop(o), w: o.w, h: o.h };
    if (o.type === "mover") return { x: o.x, y: 0, w: o.w, h: GROUND_Y };
    return null;
  }
  // 壁を上下に動かす（空中化）。地面に着いたら接地（o.y削除）に戻す。
  function wallLift(o, dy) {
    const top = (o.y != null ? o.y : GROUND_Y - o.h) + dy;
    if (top + o.h >= GROUND_Y) delete o.y;        // 接地
    else o.y = Math.max(-60, Math.round(top));    // 空中
  }
  function hitObstacle(wx, wy) {
    // 後ろ（新しいもの）から優先
    for (let i = stage.obstacles.length - 1; i >= 0; i--) {
      const o = stage.obstacles[i], b = obstBounds(o);
      if (!b) continue;
      if (o.type === "hole") {
        if (wx >= b.x && wx <= b.x + b.w && wy >= GROUND_Y - 4 && wy <= GROUND_Y + 70) return o;
      } else if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return o;
    }
    return null;
  }
  function hitStar(wx, wy) {
    for (let i = stage.items.length - 1; i >= 0; i--) {
      const it = stage.items[i];
      const dx = it.x - wx, dy = it.y - wy;
      if (dx * dx + dy * dy < 18 * 18) return it;
    }
    return null;
  }
  function holeAtWorld(wx) {
    for (const o of stage.obstacles)
      if (o.type === "hole" && wx >= o.x1 && wx <= o.x2) return o;
    return null;
  }

  // =========================================================================
  // 配置・選択・編集
  // =========================================================================
  function placeAt(wx, wy) {
    let obj = null;
    if (tool === "hole") {
      obj = { type: "hole", x1: Math.round(wx - 110), x2: Math.round(wx + 110) };
      stage.obstacles.push(obj);
    } else if (tool === "wall") {
      obj = { type: "wall", x: Math.round(wx - 14), w: 28, h: 110, color: COL_WHITE };
      // 地面から十分上でクリックしたら「空中の壁」にする（接地壁は y を持たない）
      if (wy < GROUND_Y - 130) { obj.h = 90; obj.y = Math.round(wy - 45); }
      stage.obstacles.push(obj);
    } else if (tool === "mover") {
      const cy = Math.max(120, Math.min(GROUND_Y - 40, Math.round(wy)));
      obj = { type: "mover", x: Math.round(wx - 17), w: 34, center: cy,
              ampl: 40, gapH: 130, phase: 0, speed: 1.4, color: COL_WHITE };
      stage.obstacles.push(obj);
    } else if (tool === "star") {
      obj = { x: Math.round(wx), y: Math.round(wy) };
      stage.items.push(obj);
    } else if (tool === "island") {
      const h = holeAtWorld(wx);
      if (!h) { showToast("浮島は穴の中に置きます"); return; }
      if (h.island) { delete h.island; selected = h; buildInspector(); return; }
      const cx = (h.x1 + h.x2) / 2;
      h.island = { x1: Math.round(cx - 33), x2: Math.round(cx + 33), color: COL_BLACK };
      selected = h; buildInspector(); return;
    }
    if (obj) { selected = obj; buildInspector(); }
  }

  function deleteSelected() {
    if (!selected) return;
    let i = stage.obstacles.indexOf(selected);
    if (i >= 0) stage.obstacles.splice(i, 1);
    i = stage.items.indexOf(selected);
    if (i >= 0) stage.items.splice(i, 1);
    selected = null; buildInspector();
  }

  function nudge(dx, dy) {
    if (!selected) return;
    const o = selected;
    if (o.type === "hole") { o.x1 += dx; o.x2 += dx; if (o.island) { o.island.x1 += dx; o.island.x2 += dx; } }
    else if (o.type === "wall") { o.x += dx; if (dy) wallLift(o, dy); }
    else if (o.type === "mover") { o.x += dx; o.center += dy; }
    else { o.x += dx; o.y += dy; } // star
    buildInspector();
  }

  // =========================================================================
  // インスペクタ（選択オブジェクトのプロパティ編集UIを動的生成）
  // =========================================================================
  const inspBody = document.getElementById("inspBody");
  function field(label, value, step, onInput) {
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("label"); lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number"; inp.value = Math.round(value * 1000) / 1000; inp.step = step;
    inp.addEventListener("input", function () { onInput(parseFloat(inp.value) || 0); });
    row.appendChild(lab); row.appendChild(inp); inspBody.appendChild(row);
  }
  function checkboxRow(label, checked, note, onChange) {
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("label"); lab.textContent = label;
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked;
    cb.style.cssText = "flex:0 0 auto;width:18px;height:18px;";
    cb.addEventListener("change", function () { onChange(cb.checked); });
    const sp = document.createElement("span"); sp.className = "hint"; sp.textContent = note || "";
    row.appendChild(lab); row.appendChild(cb); row.appendChild(sp); inspBody.appendChild(row);
  }
  function colorPicker(current, onPick) {
    const row = document.createElement("div"); row.className = "row";
    const lab = document.createElement("label"); lab.textContent = "色";
    const wrap = document.createElement("div"); wrap.className = "swatches";
    [COL_ORANGE, COL_BLACK, COL_WHITE].forEach(function (c) {
      const sw = document.createElement("div");
      sw.className = "swatch" + (c === current ? " sel" : "");
      sw.style.background = PALETTE[c].main;
      sw.title = c;
      sw.addEventListener("click", function () { onPick(c); });
      wrap.appendChild(sw);
    });
    row.appendChild(lab); row.appendChild(wrap); inspBody.appendChild(row);
  }
  function buildInspector() {
    inspBody.innerHTML = "";
    const o = selected;
    if (!o) { inspBody.innerHTML = '<p class="empty">オブジェクトを選択してください</p>'; return; }
    const head = document.createElement("p");
    head.style.cssText = "font-weight:700;margin-bottom:10px;";
    if (o.type === "hole") {
      head.textContent = "穴";
      inspBody.appendChild(head);
      field("左端 x1", o.x1, 5, v => { o.x1 = v; });
      field("右端 x2", o.x2, 5, v => { o.x2 = v; });
      const note = document.createElement("p"); note.className = "hint";
      note.textContent = o.island ? "浮島あり（浮島ツールでクリックして解除）" : "浮島ツールで穴内をクリックすると足場を追加";
      inspBody.appendChild(note);
      if (o.island) {
        const sub = document.createElement("p"); sub.style.cssText = "font-weight:700;margin:8px 0;"; sub.textContent = "浮島";
        inspBody.appendChild(sub);
        field("左端", o.island.x1, 5, v => { o.island.x1 = v; });
        field("右端", o.island.x2, 5, v => { o.island.x2 = v; });
        colorPicker(o.island.color, c => { o.island.color = c; buildInspector(); });
      }
    } else if (o.type === "wall") {
      head.textContent = "壁"; inspBody.appendChild(head);
      field("x（左端）", o.x, 5, v => { o.x = v; });
      field("幅 w", o.w, 1, v => { o.w = Math.max(4, v); });
      field("高さ h", o.h, 5, v => { o.h = Math.max(8, v); });
      colorPicker(o.color, c => { o.color = c; buildInspector(); });
      // 空中（浮かせる）：チェックで o.y を持たせる。解除で接地に戻す。
      checkboxRow("空中に浮かせる", o.y != null, "地面から離して配置", function (on) {
        if (on) { if (o.y == null) o.y = Math.max(-60, GROUND_Y - o.h - 80); }
        else { delete o.y; }
        buildInspector();
      });
      if (o.y != null) field("上端 y", o.y, 5, v => { o.y = v; });
      // breakable（ブレイクチャージ専用の壊せる白壁）
      checkboxRow("破壊可能", !!o.breakable, "白壁をフルチャージで破壊", function (on) { o.breakable = on; });
    } else if (o.type === "mover") {
      head.textContent = "移動壁"; inspBody.appendChild(head);
      field("x（左端）", o.x, 5, v => { o.x = v; });
      field("幅 w", o.w, 1, v => { o.w = Math.max(4, v); });
      field("中心高さ", o.center, 5, v => { o.center = v; });
      field("振幅", o.ampl, 2, v => { o.ampl = Math.max(0, v); });
      field("隙間 gapH", o.gapH, 5, v => { o.gapH = Math.max(40, v); });
      field("速度", o.speed, 0.1, v => { o.speed = v; });
      field("位相", o.phase, 0.1, v => { o.phase = v; });
      colorPicker(o.color, c => { o.color = c; buildInspector(); });
    } else {
      head.textContent = "スター"; inspBody.appendChild(head);
      field("x", o.x, 5, v => { o.x = v; });
      field("y（高さ）", o.y, 5, v => { o.y = v; });
    }
    const del = document.createElement("button");
    del.className = "danger"; del.textContent = "削除 (Delete)";
    del.style.marginTop = "8px";
    del.addEventListener("click", deleteSelected);
    inspBody.appendChild(del);
  }

  // =========================================================================
  // 描画
  // =========================================================================
  function draw() {
    ctx.clearRect(0, 0, W, H);
    // 空（編集時はフラットな明色、ゲームのグラデは省略）
    ctx.fillStyle = "#efd293";
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(0, GROUND_SCREEN_Y);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam, -GROUND_Y);

    drawGround();
    drawObstacles();
    drawItems();
    if (mode === "dead") drawTrajectory(lastTrajectory, 0.9);
    else if (mode === "edit" && lastTrajectory.length > 1) drawTrajectory(lastTrajectory, 0.32);
    if (mode === "play" || mode === "dead") drawPlayer();
    if (mode === "edit") drawSelection();
    drawGoal();

    ctx.restore();

    if (mode === "edit") drawGrid();
    drawOverlay();
  }

  // 直前の試遊のボール軌道（破線）と、死亡地点の×印。ワールド座標で描画。
  function drawTrajectory(pts, alpha) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#1a73c0"; ctx.lineWidth = 2 / zoom;
    ctx.setLineDash([8 / zoom, 6 / zoom]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y - BALL_R);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y - BALL_R);
    ctx.stroke();
    ctx.setLineDash([]);
    const last = pts[pts.length - 1], s = 9 / zoom;
    ctx.strokeStyle = "#c0271a"; ctx.lineWidth = 3 / zoom;
    ctx.beginPath();
    ctx.moveTo(last.x - s, last.y - BALL_R - s); ctx.lineTo(last.x + s, last.y - BALL_R + s);
    ctx.moveTo(last.x + s, last.y - BALL_R - s); ctx.lineTo(last.x - s, last.y - BALL_R + s);
    ctx.stroke();
    ctx.restore();
  }

  // 地面・スターは共有エンジンに委譲。障害物は共有描画＋編集アフォーダンス重ね描き。
  function drawGround() {
    Bound.drawGround(ctx, stage.obstacles, cam, zoom, mode === "play" ? player.ballColor : null);
  }
  function drawObstacles() {
    const ballColor = (mode === "play") ? player.ballColor : null;
    Bound.drawObstacles(ctx, stage.obstacles, cam, zoom, edTime, ballColor);
    // 編集アフォーダンス（破壊壁マーク／移動壁の可動範囲）を重ねる
    for (const o of stage.obstacles) {
      if (o.type === "wall" && o.breakable) {
        const wtop = Bound.wallTop(o);
        ctx.strokeStyle = "#c0271a"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(o.x + 4, wtop + 8); ctx.lineTo(o.x + o.w - 4, wtop + o.h * 0.5);
        ctx.lineTo(o.x + 6, wtop + o.h * 0.55); ctx.lineTo(o.x + o.w - 4, o.h + wtop - 6);
        ctx.stroke();
      } else if (o.type === "mover" && mode === "edit") {
        ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.strokeRect(o.x, o.center - o.ampl - o.gapH / 2, o.w, 2 * (o.ampl + o.gapH / 2));
        ctx.setLineDash([]);
      }
    }
  }
  function moverGap(o) { return Bound.moverGap(o, edTime); }
  function drawItems() { Bound.drawItems(ctx, stage.items, cam, zoom, edTime); }
  function drawSelection() {
    if (!selected) return;
    const o = selected;
    let b;
    if (o.type === "hole" || o.type === "wall" || o.type === "mover") b = obstBounds(o);
    else b = { x: o.x - ITEM_R, y: o.y - ITEM_R, w: ITEM_R * 2, h: ITEM_R * 2 };
    ctx.strokeStyle = "#1a73c0"; ctx.lineWidth = 2 / zoom; ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    ctx.setLineDash([]);
  }
  function drawGoal() {
    const gx = stage.length;
    ctx.strokeStyle = "#1a73c0"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(gx, -60); ctx.lineTo(gx, GROUND_Y + 40); ctx.stroke();
    // チェッカー旗
    ctx.fillStyle = "#1a73c0";
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++)
      if ((i + j) % 2 === 0) ctx.fillRect(gx + j * 11, -55 + i * 11, 11, 11);
  }
  function drawGrid() {
    // 編集時の縦グリッド（100px = 10m ごと）と距離ラベル
    ctx.save();
    ctx.font = "11px sans-serif"; ctx.textAlign = "center";
    const startM = Math.floor(cam / 100) * 100;
    for (let wx = startM; wx < cam + W / zoom; wx += 100) {
      const s = worldToScreen(wx, GROUND_Y);
      ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, H); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText((wx / 10) + "m", s.x, 14);
    }
    ctx.restore();
  }
  function drawOverlay() {
    if (mode === "play" || mode === "dead") {
      // 右上のHUD
      ctx.fillStyle = "rgba(20,30,50,0.78)";
      roundRect(W - 250, 12, 238, 56, 8); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(mode === "dead" ? "停止中  /  Esc で編集へ" : "テストプレイ中  /  Esc で編集へ", W - 238, 34);
      ctx.fillStyle = "#9fd8ff"; ctx.font = "12px sans-serif";
      ctx.fillText("距離 " + Math.floor(player.x / 10) + "m  ★" + collected + "  死亡 " + deaths, W - 238, 54);
      ctx.textAlign = "left";
    }
    if (mode === "dead") {
      ctx.fillStyle = "rgba(10,12,28,0.5)"; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.fillStyle = "#ff7080"; ctx.font = "bold 44px sans-serif";
      ctx.fillText("GAME OVER", W / 2, H / 2 - 22);
      ctx.fillStyle = "#fff"; ctx.font = "15px sans-serif";
      ctx.fillText("直前の軌道を表示中。クリック / Space で再挑戦、Esc で編集へ", W / 2, H / 2 + 14);
      ctx.fillStyle = "#9fd8ff"; ctx.font = "12px sans-serif";
      ctx.fillText("Trajectory shown — Click / Space to retry, Esc to edit", W / 2, H / 2 + 36);
      ctx.textAlign = "left";
    }
    if (mode === "play" && cleared) {
      ctx.fillStyle = "rgba(10,12,28,0.6)"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#5ad6c0"; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("STAGE CLEAR", W / 2, H / 2);
      ctx.fillStyle = "#fff"; ctx.font = "16px sans-serif";
      ctx.fillText("Esc で編集へ戻る", W / 2, H / 2 + 36);
      ctx.textAlign = "left";
    }
  }
  function roundRect(x, y, w, h, r) { Bound.roundRect(ctx, x, y, w, h, r); }
  function drawPlayer() {
    Bound.drawBall(ctx, player, charge, edTime, { alive: true, breakJump: player.breakJump });
  }

  // =========================================================================
  // テストプレイ（index.html の物理を忠実に再現）
  // =========================================================================
  let player, charge, holding, collected, deaths, cleared;
  function startPlay() {
    syncFromUI();
    mode = "play";
    player = { x: 60, y: GROUND_Y, vy: 0, vx: stage.phys.BASE_VX,
               onGround: true, nearGround: true, ballColor: COL_ORANGE, breakJump: false };
    charge = 0; holding = false; collected = 0; deaths = 0; cleared = false;
    cam = player.x - CAM_ANCHOR / zoom;
    trajectory = [{ x: player.x, y: player.y }];
    // テスト用に障害物/アイテムをディープコピー（破壊しても元データを汚さない）
    playObstacles = JSON.parse(JSON.stringify(stage.obstacles));
    playItems = JSON.parse(JSON.stringify(stage.items));
    document.getElementById("btnPlay").textContent = "■ 停止 (Esc)";
  }
  function stopPlay() {
    if (trajectory.length > 1) lastTrajectory = trajectory.slice(); // 編集に戻っても軌道を残す
    mode = "edit";
    document.getElementById("btnPlay").textContent = "▶ テストプレイ";
  }
  // 試遊中のミス：即リセットせず一時停止し、直前の軌道を表示する
  function gameOver() {
    deaths++;
    lastTrajectory = trajectory.slice();
    mode = "dead";
  }
  let playObstacles = [], playItems = [];

  function P() { return stage.phys; }
  // 軌道速度は共有エンジン（本編と同一の数式）
  function runSpeedAt(x) { return Bound.runSpeedAt(P(), x, 0); }
  function launch(c) {
    const p = player;
    p.vy = -P().BASE_VY * (1 - c * P().HEIGHT_PEN);
    p.vx = runSpeedAt(p.x) + c * P().BOOST_MAX;
    p.onGround = false;
    p.breakJump = c >= 0.98;
    charge = 0;
  }
  function updatePlay(dt) {
    const p = player;
    p.nearGround = p.onGround || (p.vy >= 0 && (GROUND_Y - p.y) <= NEAR_GROUND_H);
    const canCharge = holding && p.nearGround;
    if (canCharge) charge = Math.min(CHARGE_MAX, charge + dt / P().CHARGE_TIME);
    if (p.onGround) {
      if (holding && charge < CHARGE_MAX) {
        const jumpDist = runSpeedAt(p.x) * (2 * P().BASE_VY / P().G);
        p.vx = jumpDist / P().CHARGE_TIME; p.y = GROUND_Y; p.vy = 0;
      } else if (charge > 0) launch(charge);
      else launch(0);
    } else {
      p.vy += P().G * dt;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    trajectory.push({ x: p.x, y: p.y }); // 軌道を記録（死亡地点まで）
    if (p.y >= GROUND_Y) {
      if (Bound.landableAt(playObstacles, p.x, player.ballColor)) { p.y = GROUND_Y; p.vy = 0; p.onGround = true; p.breakJump = false; }
      else { p.onGround = false; if (p.y > DEATH_Y) return gameOver(); }
    }
    // 衝突
    const left = p.x - PLAYER_W / 2, right = p.x + PLAYER_W / 2, top = p.y - PLAYER_H, bottom = p.y;
    for (let i = 0; i < playObstacles.length; i++) {
      const o = playObstacles[i];
      if (o.color && o.color === p.ballColor) continue;
      if (o.type === "wall") {
        const wtop = Bound.wallTop(o), wbot = Bound.wallBottom(o);
        if (right > o.x && left < o.x + o.w && bottom > wtop && top < wbot) {
          if (p.breakJump && o.color === COL_WHITE) { playObstacles.splice(i, 1); i--; continue; }
          return gameOver();
        }
      } else if (o.type === "mover") {
        if (right > o.x && left < o.x + o.w) {
          const g = Bound.moverGap(o, edTime);
          if (top < g.top || bottom > g.bottom) return gameOver();
        }
      }
    }
    // スター取得
    const bcx = p.x, bcy = p.y - BALL_R;
    for (let i = playItems.length - 1; i >= 0; i--) {
      const it = playItems[i], dx = it.x - bcx, dy = it.y - bcy;
      if (dx * dx + dy * dy < ITEM_COLLECT_R * ITEM_COLLECT_R) { playItems.splice(i, 1); collected++; }
    }
    // ゴール
    if (p.x >= stage.length) cleared = true;
    // カメラ
    const camTarget = p.x - CAM_ANCHOR / zoom;
    cam += (camTarget - cam) * Math.min(1, CAM_SMOOTH * dt);
  }

  // =========================================================================
  // 入力
  // =========================================================================
  function evToCanvas(e) {
    const r = cv.getBoundingClientRect();
    const src = (e.touches && e.touches[0]) ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * (W / r.width), y: (src.clientY - r.top) * (H / r.height) };
  }
  cv.addEventListener("mousedown", function (e) {
    const pt = evToCanvas(e), w = screenToWorld(pt.x, pt.y);
    if (mode === "dead") { startPlay(); return; }   // 停止中はクリックで再挑戦
    if (mode === "play") { holding = true; airTapColor(); return; }
    if (tool === "select") {
      const o = hitObstacle(w.x, w.y) || hitStar(w.x, w.y);
      if (o) {
        selected = o; buildInspector();
        const b = (o.type ? obstBounds(o) : null);
        dragging = { obj: o, ox: w.x, oy: w.y };
      } else {
        selected = null; buildInspector();
        panning = { startSX: pt.x, startCam: cam };
      }
    } else if (tool === "island") {
      placeAt(w.x, w.y);
    } else {
      placeAt(w.x, w.y);
      // 配置後すぐドラッグで位置調整できるように
      dragging = { obj: selected, ox: w.x, oy: w.y };
    }
  });
  window.addEventListener("mousemove", function (e) {
    if (mode !== "edit") return;
    if (panning) {
      const pt = evToCanvas(e);
      cam = panning.startCam - (pt.x - panning.startSX) / zoom;
      clampCam(); syncScroll(); return;
    }
    if (dragging && dragging.obj) {
      const pt = evToCanvas(e), w = screenToWorld(pt.x, pt.y);
      const dx = w.x - dragging.ox, dy = w.y - dragging.oy;
      moveObj(dragging.obj, dx, dy);
      dragging.ox = w.x; dragging.oy = w.y;
      buildInspector();
    }
  });
  window.addEventListener("mouseup", function () {
    if (mode === "play") { holding = false; return; }
    dragging = null; panning = null;
  });
  cv.addEventListener("wheel", function (e) {
    if (mode !== "edit") return;
    e.preventDefault();
    cam += (e.deltaY + e.deltaX) / zoom;
    clampCam(); syncScroll();
  }, { passive: false });

  function moveObj(o, dx, dy) {
    if (o.type === "hole") { o.x1 += dx; o.x2 += dx; if (o.island) { o.island.x1 += dx; o.island.x2 += dx; } }
    else if (o.type === "wall") { o.x += dx; if (dy) wallLift(o, dy); } // 上下ドラッグで空中化
    else if (o.type === "mover") { o.x += dx; o.center = Math.max(60, Math.min(GROUND_Y - 20, o.center + dy)); }
    else { o.x += dx; o.y += dy; }
  }
  function airTapColor() {
    // テストプレイ：空中で押すと色チェンジ（orange→black→white 巡回）
    if (player.onGround || player.nearGround) return;
    holding = false; // 空中は色チェンジ専用
    const arr = [COL_ORANGE, COL_BLACK, COL_WHITE];
    const i = arr.indexOf(player.ballColor);
    player.ballColor = arr[(i + 1) % arr.length];
  }

  window.addEventListener("keydown", function (e) {
    if (mode === "dead") {
      if (e.code === "Escape") stopPlay();
      else if (e.code === "Space") { e.preventDefault(); startPlay(); } // 再挑戦
      return;
    }
    if (mode === "play") {
      if (e.code === "Escape") { stopPlay(); }
      else if (e.code === "Space") { e.preventDefault(); if (cleared) return; if (player.nearGround || player.onGround) holding = true; else airTapColor(); }
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); deleteSelected(); }
    else if (e.code === "ArrowLeft")  { e.preventDefault(); nudge(e.shiftKey ? -1 : -10, 0); }
    else if (e.code === "ArrowRight") { e.preventDefault(); nudge(e.shiftKey ? 1 : 10, 0); }
    else if (e.code === "ArrowUp")    { e.preventDefault(); nudge(0, e.shiftKey ? -1 : -10); }
    else if (e.code === "ArrowDown")  { e.preventDefault(); nudge(0, e.shiftKey ? 1 : 10); }
  });
  window.addEventListener("keyup", function (e) {
    if (mode === "play" && e.code === "Space") holding = false;
  });

  function clampCam() {
    const max = Math.max(0, stage.length + 200 - W / zoom * 0.3);
    cam = Math.max(-100, Math.min(max, cam));
  }

  // =========================================================================
  // ツールバー / パネル UI
  // =========================================================================
  document.querySelectorAll("#tools .tool").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#tools .tool").forEach(b => b.classList.remove("active"));
      btn.classList.add("active"); tool = btn.dataset.tool;
    });
  });
  document.getElementById("btnPlay").addEventListener("click", function () {
    if (mode === "edit") startPlay(); else stopPlay();
  });
  document.getElementById("btnNew").addEventListener("click", function () {
    if (!confirm("現在の内容を破棄して新規作成しますか？")) return;
    stage = newStage(); selected = null; cam = 0; lastTrajectory = []; syncToUI(); buildInspector(); syncScroll();
  });
  document.getElementById("zoom").addEventListener("input", function (e) {
    zoom = parseFloat(e.target.value); clampCam();
  });

  const scrollEl = document.getElementById("scroll");
  scrollEl.addEventListener("input", function () { cam = parseFloat(scrollEl.value); clampCam(); });
  function syncScroll() {
    scrollEl.max = Math.max(1000, stage.length + 400);
    scrollEl.value = cam;
    document.getElementById("posLbl").textContent = Math.round(cam / 10) + " m";
    document.getElementById("lenLbl").textContent = "全長 " + Math.round(stage.length / 10) + " m";
  }

  // メタ/物理 UI ⇔ データ 同期
  const metaEls = { name: "m_name", en: "m_en", hint: "m_hint" }; // req はチェックボックス（複数選択）で別扱い
  const physEls = ["G", "BASE_VY", "BASE_VX", "BOOST_MAX", "HEIGHT_PEN", "CHARGE_TIME", "SPEED_ACCEL", "SPEED_EXTRA_MAX"];
  // 解放スキル（複数選択＝全て必要）
  function reqFromUI() {
    return [].slice.call(document.querySelectorAll("#m_req input:checked")).map(function (c) { return c.value; });
  }
  function reqToUI(arr) {
    const set = new Set(arr || []);
    document.querySelectorAll("#m_req input").forEach(function (c) { c.checked = set.has(c.value); });
  }
  function syncFromUI() {
    for (const k in metaEls) stage.meta[k] = document.getElementById(metaEls[k]).value;
    stage.meta.req = reqFromUI();
    stage.length = parseFloat(document.getElementById("m_length").value) || 6000;
    for (const k of physEls) stage.phys[k] = parseFloat(document.getElementById("p_" + k).value);
  }
  function syncToUI() {
    for (const k in metaEls) document.getElementById(metaEls[k]).value = stage.meta[k] || "";
    reqToUI(stage.meta.req);
    document.getElementById("m_length").value = stage.length;
    for (const k of physEls) document.getElementById("p_" + k).value = stage.phys[k];
    syncScroll();
  }
  // 入力のたびに反映
  Object.values(metaEls).forEach(id => document.getElementById(id).addEventListener("input", syncFromUI));
  document.querySelectorAll("#m_req input").forEach(c => c.addEventListener("change", syncFromUI));
  document.getElementById("m_length").addEventListener("input", function () { syncFromUI(); syncScroll(); });
  physEls.forEach(k => document.getElementById("p_" + k).addEventListener("input", syncFromUI));

  // =========================================================================
  // 保存 / 読み込み
  // =========================================================================
  const GAME_KEY = "cr_custom_stages";
  function serialize() { syncFromUI(); return JSON.stringify(stage, null, 2); }
  function loadStageObj(obj) {
    const m = obj.meta || {};
    stage = {
      meta: { name: m.name || "", en: m.en || "", hint: m.hint || "",
              req: Array.isArray(m.req) ? m.req : (m.req ? [m.req] : []) },
      phys: Object.assign({}, PHYS_DEFAULT, obj.phys || {}),
      length: obj.length || 6000,
      obstacles: obj.obstacles || [],
      items: obj.items || []
    };
    selected = null; cam = 0; lastTrajectory = []; syncToUI(); buildInspector();
  }
  document.getElementById("btnExport").addEventListener("click", function () {
    document.getElementById("io").value = serialize(); showToast("JSONを出力しました");
  });
  document.getElementById("btnImport").addEventListener("click", function () {
    try { loadStageObj(JSON.parse(document.getElementById("io").value)); showToast("取り込みました"); }
    catch (e) { showToast("JSONの解析に失敗しました"); }
  });
  document.getElementById("btnDownload").addEventListener("click", function () {
    const blob = new Blob([serialize()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (stage.meta.en || "stage").replace(/[^\w-]/g, "_") + ".json";
    a.click(); URL.revokeObjectURL(a.href);
  });
  document.getElementById("btnToGame").addEventListener("click", function () {
    syncFromUI();
    if (!stage.meta.name) { showToast("ステージ名を入れてください"); return; }
    let list = [];
    try { list = JSON.parse(localStorage.getItem(GAME_KEY) || "[]"); } catch (e) { list = []; }
    const idx = list.findIndex(s => s.meta && s.meta.name === stage.meta.name);
    const data = JSON.parse(serialize());
    if (idx >= 0) list[idx] = data; else list.push(data);
    localStorage.setItem(GAME_KEY, JSON.stringify(list));
    showToast("ゲームに保存しました（" + list.length + "件）。index.html のステージ選択に表示されます");
  });
  document.getElementById("btnFromGame").addEventListener("click", function () {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(GAME_KEY) || "[]"); } catch (e) {}
    if (!list.length) { showToast("ゲームに保存されたステージがありません"); return; }
    const names = list.map((s, i) => (i + 1) + ": " + (s.meta ? s.meta.name : "?")).join("\n");
    const sel = prompt("読み込むステージ番号:\n" + names, "1");
    const i = parseInt(sel, 10) - 1;
    if (i >= 0 && i < list.length) { loadStageObj(list[i]); showToast("読み込みました"); }
  });

  // =========================================================================
  // トースト
  // =========================================================================
  const toastEl = document.getElementById("toast");
  let toastTimer = 0;
  function showToast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // =========================================================================
  // メインループ
  // =========================================================================
  let lastT = performance.now(), acc = 0;
  const STEP = 1 / 120;
  function loop(now) {
    let frame = (now - lastT) / 1000; lastT = now;
    if (frame > 0.25) frame = 0.25;
    edTime += frame;
    if (mode === "play" && !cleared) { acc += frame; while (acc >= STEP) { updatePlay(STEP); acc -= STEP; } }
    else acc = 0;
    // 試遊中・停止中は play 用配列（破壊などが反映された状態）で描画する
    if (mode === "play" || mode === "dead") {
      const so = stage.obstacles, si = stage.items;
      stage.obstacles = playObstacles; stage.items = playItems;
      draw();
      stage.obstacles = so; stage.items = si;
    } else {
      draw();
    }
    requestAnimationFrame(loop);
  }

  // 初期サンプル（穴→壁→移動壁→黒壁＋スター）
  function sample() {
    stage.obstacles = [
      { type: "hole", x1: 900, x2: 1090 },
      { type: "wall", x: 1700, w: 28, h: 100, color: COL_WHITE },
      { type: "mover", x: 2500, w: 34, center: 320, ampl: 50, gapH: 130, phase: 0, speed: 1.4, color: COL_ORANGE },
      { type: "wall", x: 3300, w: 28, h: 200, color: COL_BLACK }
    ];
    stage.items = [{ x: 1000, y: 320 }, { x: 2500, y: 280 }];
    stage.length = 4000;
  }
  sample();
  syncToUI(); buildInspector(); syncScroll();
  requestAnimationFrame(loop);
})();