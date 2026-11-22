import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// ============================================================================
// 1. PURE SIMULATION / WORLD CONFIG & HELPERS
// ============================================================================
const WORLD = {
  roadHalfWidth: 11.5,
  sidewalkWidth: 7.5,
  sidewalkHeight: 0.16,
  bounds: 155,
  mallZone: { x: -19.2, z: 10, radius: 4.5 },
  safeHouseZone: { x: 24, z: -32, radius: 4.5 },
};

const START_CASH = 24517;

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function formatCash(amount) {
  const n = Math.max(0, Math.floor(amount));
  return '$' + String(n).padStart(8, '0');
}

// ============================================================================
// 2. PROCEDURAL WEB AUDIO ENGINE (Zero external audio files)
// ============================================================================
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.engineOsc = null;
    this.engineGain = null;
    this.stepTimer = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.engineGain && this.ctx) {
      this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  playTone(freq, endFreq, duration, type = 'sine', vol = 0.12) {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playStep(sprinting) {
    this.playTone(sprinting ? 145 : 115, 55, 0.06, 'triangle', sprinting ? 0.06 : 0.04);
  }

  playJump() {
    this.playTone(180, 340, 0.14, 'sine', 0.09);
  }

  playPunch() {
    this.playTone(220, 68, 0.13, 'sawtooth', 0.12);
  }

  playCash() {
    this.playTone(587, 880, 0.09, 'triangle', 0.11);
    setTimeout(() => this.playTone(880, 1175, 0.14, 'triangle', 0.11), 65);
  }

  playCarDoor() {
    this.playTone(130, 52, 0.11, 'square', 0.1);
  }

  playBump() {
    this.playTone(110, 38, 0.18, 'sawtooth', 0.15);
  }

  updateEngine(active, speedRatio) {
    if (this.muted || !this.ctx || !active) {
      if (this.engineGain && this.ctx) {
        this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      }
      return;
    }
    if (!this.engineOsc) {
      this.engineOsc = this.ctx.createOscillator();
      this.engineGain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 340;
      this.engineOsc.type = 'sawtooth';
      this.engineOsc.frequency.value = 54;
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(filter);
      filter.connect(this.engineGain);
      this.engineGain.connect(this.ctx.destination);
      this.engineOsc.start();
    }
    const targetFreq = 52 + Math.abs(speedRatio) * 118;
    const targetVol = 0.035 + Math.abs(speedRatio) * 0.055;
    this.engineOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.06);
    this.engineGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.08);
  }
}

// ============================================================================
// 3. PROCEDURAL PBR CANVAS TEXTURES
// ============================================================================
function createTextures(maxAniso) {
  function finalize(canvas, isColor = true, repeatX = 1, repeatY = 1) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.needsUpdate = true;
    return tex;
  }

  // 3A. Boulevard Wet-Look Asphalt + Lane Markings + Roughness Map
  const roadCanvas = document.createElement('canvas');
  roadCanvas.width = 1024;
  roadCanvas.height = 1024;
  const rctx = roadCanvas.getContext('2d');

  const roadRoughCanvas = document.createElement('canvas');
  roadRoughCanvas.width = 512;
  roadRoughCanvas.height = 512;
  const rrctx = roadRoughCanvas.getContext('2d');

  rctx.fillStyle = '#17191f';
  rctx.fillRect(0, 0, 1024, 1024);

  // Subtle asphalt aggregate grain & tire wear tracks
  for (let i = 0; i < 16000; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const v = 18 + Math.floor(Math.random() * 18);
    rctx.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
    rctx.fillRect(x, y, 2, 2);
  }
  // Darker tire wear tracks along 4 lanes
  [160, 350, 670, 860].forEach((lx) => {
    const grad = rctx.createLinearGradient(lx - 55, 0, lx + 55, 0);
    grad.addColorStop(0, 'rgba(8,10,14,0)');
    grad.addColorStop(0.5, 'rgba(7,9,13,0.42)');
    grad.addColorStop(1, 'rgba(8,10,14,0)');
    rctx.fillStyle = grad;
    rctx.fillRect(lx - 55, 0, 110, 1024);
  });

  // Double yellow center line
  rctx.fillStyle = '#eab308';
  rctx.fillRect(498, 0, 9, 1024);
  rctx.fillRect(517, 0, 9, 1024);

  // White dashed lane dividers
  rctx.fillStyle = '#e2e8f0';
  for (let y = 0; y < 1024; y += 128) {
    rctx.fillRect(256, y + 18, 8, 68);
    rctx.fillRect(760, y + 18, 8, 68);
  }

  // Subtle edge shoulder lines
  rctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
  rctx.fillRect(18, 0, 6, 1024);
  rctx.fillRect(1000, 0, 6, 1024);

  // Road wet-sheen roughness map (darker = glossy wet reflection patches)
  rrctx.fillStyle = '#9c9c9c';
  rrctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 55; i++) {
    const px = Math.random() * 512;
    const py = Math.random() * 512;
    const rx = 25 + Math.random() * 70;
    const ry = 70 + Math.random() * 150;
    const g = rrctx.createRadialGradient(px, py, 4, px, py, ry);
    g.addColorStop(0, 'rgba(22, 22, 22, 0.85)');
    g.addColorStop(1, 'rgba(156, 156, 156, 0)');
    rrctx.fillStyle = g;
    rrctx.save();
    rrctx.translate(px, py);
    rrctx.scale(rx / ry, 1);
    rrctx.beginPath();
    rrctx.arc(0, 0, ry, 0, Math.PI * 2);
    rrctx.fill();
    rrctx.restore();
  }

  // 3B. Sidewalk Tiled Pavers + Manholes + Wet Sheen
  const swCanvas = document.createElement('canvas');
  swCanvas.width = 512;
  swCanvas.height = 512;
  const sctx = swCanvas.getContext('2d');

  const swBumpCanvas = document.createElement('canvas');
  swBumpCanvas.width = 512;
  swBumpCanvas.height = 512;
  const sbctx = swBumpCanvas.getContext('2d');

  sctx.fillStyle = '#43454a';
  sctx.fillRect(0, 0, 512, 512);
  sbctx.fillStyle = '#d8d8d8';
  sbctx.fillRect(0, 0, 512, 512);

  const tiles = 4;
  const step = 512 / tiles;
  for (let gx = 0; gx < tiles; gx++) {
    for (let gy = 0; gy < tiles; gy++) {
      const shade = 64 + Math.floor(Math.random() * 14);
      sctx.fillStyle = `rgb(${shade + 3},${shade + 2},${shade})`;
      sctx.fillRect(gx * step + 3, gy * step + 3, step - 6, step - 6);
      // Grout seams
      sctx.strokeStyle = '#26272b';
      sctx.lineWidth = 4;
      sctx.strokeRect(gx * step, gy * step, step, step);
      sbctx.strokeStyle = '#303030';
      sbctx.lineWidth = 5;
      sbctx.strokeRect(gx * step, gy * step, step, step);
    }
  }
  // Subtle concrete grain
  for (let i = 0; i < 4500; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    sctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
    sctx.fillRect(x, y, 2, 2);
  }
  // Utility manhole grate in one corner tile
  sctx.fillStyle = '#3d3e42';
  sctx.fillRect(36, 36, 74, 74);
  sctx.strokeStyle = '#252629';
  sctx.lineWidth = 3;
  sctx.strokeRect(36, 36, 74, 74);
  for (let k = 44; k < 104; k += 10) {
    sctx.fillStyle = '#27282b';
    sctx.fillRect(42, k, 62, 4);
  }

  // 3C. Los Santos City Mall Illuminated Glass Storefront
  const mallCanvas = document.createElement('canvas');
  mallCanvas.width = 1024;
  mallCanvas.height = 512;
  const mctx = mallCanvas.getContext('2d');

  // Warm interior glow behind floor-to-ceiling windows
  const mallGlow = mctx.createLinearGradient(0, 190, 0, 512);
  mallGlow.addColorStop(0, '#ffd48a');
  mallGlow.addColorStop(0.55, '#f29e4c');
  mallGlow.addColorStop(1, '#613a20');
  mctx.fillStyle = mallGlow;
  mctx.fillRect(0, 190, 1024, 322);

  // Boutique silhouettes & interior columns
  mctx.fillStyle = 'rgba(42, 26, 18, 0.58)';
  for (let x = 60; x < 1000; x += 140) {
    mctx.fillRect(x, 220, 26, 292);
    // Warm ceiling downlights
    mctx.fillStyle = '#fff5d6';
    mctx.fillRect(x + 52, 206, 44, 12);
    mctx.fillStyle = 'rgba(42, 26, 18, 0.58)';
  }

  // Dark bronze/aluminum window mullions
  mctx.fillStyle = '#1f2329';
  for (let x = 0; x <= 1024; x += 128) {
    mctx.fillRect(x - 5, 190, 10, 322);
  }
  mctx.fillRect(0, 325, 1024, 9);

  // Upper travertine limestone facade band
  mctx.fillStyle = '#b4a595';
  mctx.fillRect(0, 0, 1024, 196);
  // Subtle stone panel seams
  mctx.strokeStyle = 'rgba(55, 45, 38, 0.35)';
  mctx.lineWidth = 2;
  for (let x = 0; x < 1024; x += 128) {
    mctx.strokeRect(x, 0, 128, 98);
    mctx.strokeRect(x, 98, 128, 98);
  }

  // Illuminated "LOS SANTOS CITY MALL" Signboard
  mctx.fillStyle = '#3c352f';
  mctx.fillRect(212, 46, 600, 108);
  mctx.fillStyle = '#fff7eb';
  mctx.font = '800 46px "Plus Jakarta Sans", Arial, sans-serif';
  mctx.textAlign = 'center';
  mctx.fillText('LOS SANTOS', 512, 96);
  mctx.font = '700 34px "Plus Jakarta Sans", Arial, sans-serif';
  mctx.fillText('CITY MALL', 512, 138);

  // 3D Emissive map for mall windows & sign
  const mallEmitCanvas = document.createElement('canvas');
  mallEmitCanvas.width = 1024;
  mallEmitCanvas.height = 512;
  const mectx = mallEmitCanvas.getContext('2d');
  mectx.fillStyle = '#000000';
  mectx.fillRect(0, 0, 1024, 512);
  const emitWin = mectx.createLinearGradient(0, 195, 0, 512);
  emitWin.addColorStop(0, '#ffcb77');
  emitWin.addColorStop(0.65, '#c97834');
  emitWin.addColorStop(1, '#331c0d');
  mectx.fillStyle = emitWin;
  mectx.fillRect(0, 195, 1024, 317);
  mectx.fillStyle = '#000000';
  for (let x = 0; x <= 1024; x += 128) mectx.fillRect(x - 6, 195, 12, 317);
  mectx.fillRect(0, 325, 1024, 10);
  mectx.fillStyle = '#ffe9c4';
  mectx.font = '800 46px "Plus Jakarta Sans", Arial, sans-serif';
  mectx.textAlign = 'center';
  mectx.fillText('LOS SANTOS', 512, 96);
  mectx.font = '700 34px "Plus Jakarta Sans", Arial, sans-serif';
  mectx.fillText('CITY MALL', 512, 138);

  // 3D. Skyscraper Curtain Wall Textures (Diffuse + Emissive Window Grid)
  function makeSkyscraperTextures(tintHex, cols, rows, litRatio) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 1024;
    const ctx = c.getContext('2d');

    const ec = document.createElement('canvas');
    ec.width = 512;
    ec.height = 1024;
    const ectx = ec.getContext('2d');

    ctx.fillStyle = tintHex;
    ctx.fillRect(0, 0, 512, 1024);
    ectx.fillStyle = '#000000';
    ectx.fillRect(0, 0, 512, 1024);

    const cw = 512 / cols;
    const ch = 1024 / rows;

    for (let r = 0; r < rows; r++) {
      // Mechanical floor band every 10 floors
      if (r % 10 === 0) {
        ctx.fillStyle = '#1e242e';
        ctx.fillRect(0, r * ch, 512, ch);
        continue;
      }
      for (let col = 0; col < cols; col++) {
        const x = col * cw + 3;
        const y = r * ch + 3;
        const w = cw - 6;
        const h = ch - 6;
        const lit = Math.random() < litRatio;
        if (lit) {
          const warm = Math.random() > 0.28;
          ctx.fillStyle = warm ? '#ffd89a' : '#a8d5f2';
          ectx.fillStyle = warm ? '#ffca78' : '#7ebfe6';
          ctx.fillRect(x, y, w, h);
          ectx.fillRect(x, y, w, h);
        } else {
          const skyReflect = 45 + Math.floor(Math.random() * 35);
          ctx.fillStyle = `rgb(${skyReflect}, ${skyReflect + 10}, ${skyReflect + 24})`;
          ctx.fillRect(x, y, w, h);
        }
      }
    }
    return {
      map: finalize(c, true, 1, 1),
      emissiveMap: finalize(ec, true, 1, 1),
    };
  }

  // 3E. Purple Street Banner Texture
  const banCanvas = document.createElement('canvas');
  banCanvas.width = 256;
  banCanvas.height = 512;
  const bctx = banCanvas.getContext('2d');
  const banGrad = bctx.createLinearGradient(0, 0, 0, 512);
  banGrad.addColorStop(0, '#3e2d6e');
  banGrad.addColorStop(1, '#583f8f');
  bctx.fillStyle = banGrad;
  bctx.fillRect(0, 0, 256, 512);
  bctx.strokeStyle = 'rgba(255, 224, 166, 0.65)';
  bctx.lineWidth = 6;
  bctx.strokeRect(14, 14, 228, 484);
  bctx.fillStyle = '#fde68a';
  bctx.font = '800 32px "Bebas Neue", Impact, sans-serif';
  bctx.textAlign = 'center';
  bctx.fillText('LOS SANTOS', 128, 120);
  bctx.fillStyle = '#f8fafc';
  bctx.font = '700 22px "Plus Jakarta Sans", sans-serif';
  bctx.fillText('DOWNTOWN', 128, 165);
  bctx.fillText('DISTRICT', 128, 198);
  // Stylized skyline icon on banner
  bctx.fillStyle = 'rgba(255,255,255,0.85)';
  bctx.fillRect(68, 300, 20, 90);
  bctx.fillRect(94, 260, 26, 130);
  bctx.fillRect(126, 230, 30, 160);
  bctx.fillRect(162, 275, 24, 115);

  // 3F. Giant Right-Side Building Billboard Texture ("LOS SANTOS" + Skyline)
  const bbCanvas = document.createElement('canvas');
  bbCanvas.width = 1024;
  bbCanvas.height = 512;
  const bbctx = bbCanvas.getContext('2d');
  const bbGrad = bbctx.createLinearGradient(0, 0, 0, 512);
  bbGrad.addColorStop(0, '#182438');
  bbGrad.addColorStop(1, '#2d3b55');
  bbctx.fillStyle = bbGrad;
  bbctx.fillRect(0, 0, 1024, 512);
  bbctx.strokeStyle = '#0c111a';
  bbctx.lineWidth = 18;
  bbctx.strokeRect(9, 9, 1006, 494);
  // Crisp white downtown skyline silhouette
  bbctx.fillStyle = '#f8fafc';
  const towers = [
    [250, 185, 36, 115],
    [296, 150, 44, 150],
    [350, 118, 48, 182],
    [408, 86, 54, 214],
    [474, 54, 72, 246],
    [558, 96, 52, 204],
    [620, 132, 46, 168],
    [676, 162, 42, 138],
    [728, 190, 38, 110],
  ];
  towers.forEach(([tx, ty, tw, th]) => {
    bbctx.fillRect(tx, ty, tw, th);
  });
  bbctx.fillRect(498, 28, 24, 30);
  bbctx.fillStyle = '#ffffff';
  bbctx.font = '800 84px "Plus Jakarta Sans", Arial, sans-serif';
  bbctx.textAlign = 'center';
  bbctx.fillText('LOS SANTOS', 512, 392);
  bbctx.fillStyle = '#cbd5e1';
  bbctx.font = '700 22px "Plus Jakarta Sans", Arial, sans-serif';
  bbctx.fillText('CITY OF GOLDEN SUNSETS', 512, 434);

  // 3G. Palm Bark Ring Texture
  const palmCanvas = document.createElement('canvas');
  palmCanvas.width = 256;
  palmCanvas.height = 512;
  const pctx = palmCanvas.getContext('2d');
  pctx.fillStyle = '#5c4636';
  pctx.fillRect(0, 0, 256, 512);
  for (let y = 0; y < 512; y += 16) {
    pctx.fillStyle = y % 32 === 0 ? '#473427' : '#6c5340';
    pctx.fillRect(0, y, 256, 8);
    pctx.fillStyle = 'rgba(25, 18, 12, 0.35)';
    pctx.fillRect(0, y + 7, 256, 3);
  }

  // 3H. Soft Radial Contact Shadow Disc Texture
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const shctx = shadowCanvas.getContext('2d');
  const shg = shctx.createRadialGradient(64, 64, 8, 64, 64, 62);
  shg.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
  shg.addColorStop(0.6, 'rgba(0, 0, 0, 0.22)');
  shg.addColorStop(1, 'rgba(0, 0, 0, 0)');
  shctx.fillStyle = shg;
  shctx.fillRect(0, 0, 128, 128);

  return {
    roadMap: finalize(roadCanvas, true, 1, 14),
    roadRoughnessMap: finalize(roadRoughCanvas, false, 2, 18),
    sidewalkMap: finalize(swCanvas, true, 3, 46),
    sidewalkBumpMap: finalize(swBumpCanvas, false, 3, 46),
    mallMap: finalize(mallCanvas, true, 1, 1),
    mallEmissiveMap: finalize(mallEmitCanvas, true, 1, 1),
    towerA: makeSkyscraperTextures('#2d3748', 10, 28, 0.44),
    towerB: makeSkyscraperTextures('#1f2937', 8, 22, 0.38),
    towerC: makeSkyscraperTextures('#3a3e48', 12, 32, 0.48),
    bannerMap: finalize(banCanvas, true, 1, 1),
    billboardMap: finalize(bbCanvas, true, 1, 1),
    palmBarkMap: finalize(palmCanvas, true, 1, 3),
    contactShadowMap: finalize(shadowCanvas, true, 1, 1),
  };
}

// ============================================================================
// 4. PROCEDURAL COMPOSITE 3D MODELS (3–12 PARTS PER SUBJECT)
// ============================================================================
function createContactShadow(shadowTex, radius = 0.85) {
  const geo = new THREE.CircleGeometry(radius, 24);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.72,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.018;
  return mesh;
}

function createCharacterGroup(textures, options = {}) {
  const {
    shirtColor = 0x161c2e,
    pantsColor = 0x181a1f,
    skinColor = 0xd69e7a,
    hasCap = true,
    hasStripe = true,
    shoeColor = 0x111317,
  } = options;

  const root = new THREE.Group();
  root.add(createContactShadow(textures.contactShadowMap, 0.55));

  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.65, metalness: 0.02 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.78, metalness: 0.04 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: pantsColor, roughness: 0.82 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: shoeColor, roughness: 0.55 });
  const soleMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7 });

  // Tapered athletic torso + neck
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.165, 0.56, 14), shirtMat);
  torso.scale.set(1.1, 1, 0.65);
  torso.position.y = 1.16;
  torso.castShadow = true;
  bodyPivot.add(torso);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 10), skinMat);
  neck.position.y = 1.46;
  bodyPivot.add(neck);

  if (hasStripe) {
    const backStripe = new THREE.Mesh(new THREE.CylinderGeometry(0.215, 0.205, 0.042, 14), stripeMat);
    backStripe.scale.set(1.11, 1, 0.67);
    backStripe.position.y = 1.27;
    bodyPivot.add(backStripe);
  }

  // Head + Cap
  const headGroup = new THREE.Group();
  headGroup.position.y = 1.59;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.132, 16, 14), skinMat);
  head.scale.set(0.9, 1.06, 0.96);
  head.castShadow = true;
  headGroup.add(head);

  if (hasCap) {
    const capMat = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.65 });
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.138, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
      capMat
    );
    capCrown.position.y = 0.025;
    headGroup.add(capCrown);

    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.145, 0.02, 14, 1, false, -0.8, 1.6), capMat);
    brim.position.set(0, 0.035, -0.105);
    brim.rotation.x = 0.12;
    headGroup.add(brim);
  } else {
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x241913, roughness: 0.85 });
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.138, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
    hair.position.y = 0.02;
    headGroup.add(hair);
  }
  bodyPivot.add(headGroup);

  // Arms (pivoted at shoulder with natural slight outward hang)
  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.215, 1.38, 0);
    pivot.rotation.z = side * 0.06;

    const shoulderCap = new THREE.Mesh(new THREE.SphereGeometry(0.066, 10, 8), shirtMat);
    pivot.add(shoulderCap);

    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.056, 0.22, 10), shirtMat);
    sleeve.position.y = -0.1;
    pivot.add(sleeve);

    if (hasStripe) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.059, 0.03, 10), stripeMat);
      band.position.y = -0.17;
      pivot.add(band);
    }

    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.04, 0.39, 10), skinMat);
    forearm.position.y = -0.37;
    forearm.castShadow = true;
    pivot.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), skinMat);
    hand.position.y = -0.57;
    pivot.add(hand);
    return pivot;
  }

  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);
  bodyPivot.add(leftArm, rightArm);

  // Legs (pivoted at hip)
  function makeLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.12, 0.88, 0);

    const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.065, 0.78, 12), pantsMat);
    legMesh.position.y = -0.4;
    legMesh.castShadow = true;
    pivot.add(legMesh);

    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.24), shoeMat);
    shoe.position.set(0, -0.82, -0.04);
    shoe.castShadow = true;
    pivot.add(shoe);

    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.134, 0.032, 0.245), soleMat);
    sole.position.set(0, -0.865, -0.04);
    pivot.add(sole);
    return pivot;
  }

  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);
  bodyPivot.add(leftLeg, rightLeg);

  root.userData.rig = { bodyPivot, headGroup, leftArm, rightArm, leftLeg, rightLeg };
  return root;
}

function createCarGroup(textures, config = {}) {
  const {
    color = 0x14171d,
    type = 'coupe', // 'coupe' | 'sedan' | 'suv' | 'police'
  } = config;

  const root = new THREE.Group();
  root.add(createContactShadow(textures.contactShadowMap, type === 'suv' ? 2.55 : 2.35));

  const bodyPaint = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.85,
    roughness: 0.2,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0f1722,
    metalness: 0.1,
    roughness: 0.06,
    clearcoat: 1.0,
    transparent: true,
    opacity: 0.86,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.72, metalness: 0.25 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8dee9, metalness: 0.92, roughness: 0.15 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.85 });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xaa0000,
    emissive: 0xef1111,
    emissiveIntensity: 1.35,
    roughness: 0.2,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff8e6,
    emissive: 0xfff2cc,
    emissiveIntensity: 1.8,
    roughness: 0.15,
  });

  const width = type === 'suv' ? 2.02 : 1.94;
  const length = type === 'suv' ? 4.65 : 4.48;
  const chassisH = type === 'suv' ? 0.62 : 0.48;
  const chassisY = type === 'suv' ? 0.58 : 0.45;

  // 1. Sculpted Aerodynamic Extruded Chassis Silhouette (side profile extruded across X)
  const halfL = length * 0.5;
  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-halfL, 0.24);
  bodyShape.lineTo(halfL, 0.24);
  bodyShape.lineTo(halfL - 0.08, type === 'suv' ? 0.88 : 0.72); // rear trunk
  if (type === 'coupe') {
    bodyShape.lineTo(1.25, 0.82); // fastback rear deck
    bodyShape.lineTo(0.42, 1.24); // rear window slope
    bodyShape.lineTo(-0.48, 1.24); // sleek roof
    bodyShape.lineTo(-1.18, 0.76); // windshield
  } else if (type === 'suv') {
    bodyShape.lineTo(halfL - 0.28, 1.46);
    bodyShape.lineTo(-0.62, 1.48);
    bodyShape.lineTo(-1.18, 0.94);
  } else {
    bodyShape.lineTo(1.55, 0.82);
    bodyShape.lineTo(0.95, 1.28);
    bodyShape.lineTo(-0.55, 1.28);
    bodyShape.lineTo(-1.15, 0.8);
  }
  bodyShape.lineTo(-halfL + 0.14, type === 'suv' ? 0.84 : 0.66); // sloped hood nose
  bodyShape.lineTo(-halfL, 0.42);
  bodyShape.closePath();

  const extrudeGeo = new THREE.ExtrudeGeometry(bodyShape, {
    depth: width - 0.14,
    bevelEnabled: true,
    bevelThickness: 0.07,
    bevelSize: 0.05,
    bevelSegments: 2,
  });
  // Extrude is in XY (X = Z-axis length, Z = X-axis width) -> rotate +90deg Y so -X becomes -Z forward
  extrudeGeo.translate(0, 0, -(width - 0.14) * 0.5);
  extrudeGeo.rotateY(-Math.PI / 2);
  const chassis = new THREE.Mesh(extrudeGeo, bodyPaint);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  root.add(chassis);

  // 2. Tinted Window Wrap (front/rear/side greenhouse)
  const cabinW = width - 0.12;
  const cabinH = type === 'suv' ? 0.48 : 0.36;
  const cabinL = type === 'suv' ? 2.45 : 1.75;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabinW, cabinH, cabinL), glassMat);
  cabin.position.set(0, type === 'suv' ? 1.16 : 1.0, type === 'coupe' ? 0.1 : 0.15);
  root.add(cabin);

  // Police white doors & roof lightbar
  let lightbarRed = null;
  let lightbarBlue = null;
  if (type === 'police') {
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.25, metalness: 0.2 });
    const doors = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.54, 1.85), whiteMat);
    doors.position.set(0, 0.54, 0.05);
    root.add(doors);

    const barBase = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 0.22), trimMat);
    barBase.position.set(0, 1.38, 0.1);
    root.add(barBase);

    lightbarRed = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.09, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff1111, emissiveIntensity: 2.5 })
    );
    lightbarRed.position.set(-0.32, barBase.position.y + 0.02, barBase.position.z);
    lightbarBlue = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.09, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x2266ff, emissive: 0x1155ff, emissiveIntensity: 2.5 })
    );
    lightbarBlue.position.set(0.32, barBase.position.y + 0.02, barBase.position.z);
    root.add(lightbarRed, lightbarBlue);
  }

  // 3. Front Grille & Rear Diffuser + Spoiler
  const frontGrille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.62, 0.2, 0.08), trimMat);
  frontGrille.position.set(0, 0.42, -length * 0.5 - 0.02);
  root.add(frontGrille);

  const rearDiffuser = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 0.16, 0.1), trimMat);
  rearDiffuser.position.set(0, 0.32, length * 0.5 + 0.02);
  root.add(rearDiffuser);

  if (type === 'coupe') {
    const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(width * 0.88, 0.045, 0.22), bodyPaint);
    spoilerWing.position.set(0, 0.84, length * 0.5 - 0.16);
    root.add(spoilerWing);
  }

  // 4. Headlights & Twin LED Taillights
  [-0.66, 0.66].forEach((ox) => {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.11, 0.06), headMat);
    hl.position.set(ox, chassisY + 0.06, -length * 0.5 - 0.01);
    root.add(hl);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.06), tailMat);
    tl.position.set(ox, chassisY + 0.08, length * 0.5 + 0.01);
    root.add(tl);

    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10), chromeMat);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(ox * 0.85, chassisY - 0.2, length * 0.5 + 0.04);
    root.add(exhaust);
  });

  // 5. Four Wheels (Tire + Alloy Rim)
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.27, 12);
  rimGeo.rotateZ(Math.PI / 2);

  const wheels = [];
  [
    [-width * 0.48, 0.36, -length * 0.31],
    [width * 0.48, 0.36, -length * 0.31],
    [-width * 0.48, 0.36, length * 0.31],
    [width * 0.48, 0.36, length * 0.31],
  ].forEach(([wx, wy, wz]) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    const tire = new THREE.Mesh(wheelGeo, tireMat);
    tire.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, chromeMat);
    wGroup.add(tire, rim);
    root.add(wGroup);
    wheels.push(wGroup);
  });

  root.userData.carRig = { wheels, tailMat, lightbarRed, lightbarBlue, length, width };
  return root;
}

function createPalmTreeGroup(textures, heightScale = 1.0, leanDir = 1) {
  const root = new THREE.Group();
  root.add(createContactShadow(textures.contactShadowMap, 1.35));

  const trunkMat = new THREE.MeshStandardMaterial({
    map: textures.palmBarkMap,
    roughness: 0.88,
    metalness: 0.02,
  });
  const frondMat = new THREE.MeshStandardMaterial({
    color: 0x3f5e2c,
    roughness: 0.65,
    side: THREE.DoubleSide,
  });

  // Curved segmented trunk
  const segments = 6;
  const totalH = 11.5 * heightScale;
  const segH = totalH / segments;
  let curX = 0;
  let curY = 0;
  for (let i = 0; i < segments; i++) {
    const rBottom = (0.34 - i * 0.032) * heightScale;
    const rTop = (0.34 - (i + 1) * 0.032) * heightScale;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, segH + 0.12, 10), trunkMat);
    const tilt = (i * 0.035) * leanDir;
    seg.position.set(curX + Math.sin(tilt) * segH * 0.5, curY + segH * 0.5, 0);
    seg.rotation.z = -tilt;
    seg.castShadow = true;
    root.add(seg);
    curX += Math.sin(tilt) * segH;
    curY += segH;
  }

  // Crown + 11 arched palm fronds
  const crown = new THREE.Group();
  crown.position.set(curX, curY, 0);
  root.add(crown);

  const frondShape = new THREE.PlaneGeometry(0.85, 4.4 * heightScale, 3, 6);
  const pos = frondShape.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + 2.2 * heightScale; // 0 to 4.4
    const t = clamp(y / (4.4 * heightScale), 0, 1);
    const x = pos.getX(i) * (1 - t * 0.72) * (0.55 + Math.sin(t * Math.PI) * 0.75);
    const droop = -Math.pow(t, 2.1) * 1.9 * heightScale + Math.sin(t * Math.PI) * 0.55;
    pos.setXYZ(i, x, droop, -y);
  }
  frondShape.computeVertexNormals();
  frondShape.computeBoundingSphere();

  const frondCount = 11;
  for (let f = 0; f < frondCount; f++) {
    const frond = new THREE.Mesh(frondShape, frondMat);
    frond.rotation.y = (f / frondCount) * Math.PI * 2 + (f % 2) * 0.14;
    frond.rotation.x = (f % 3 === 0 ? 0.25 : -0.1);
    frond.castShadow = true;
    crown.add(frond);
  }

  return root;
}

function createStreetLampGroup(textures, side = -1, withBanner = true) {
  const root = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1e222a, metalness: 0.72, roughness: 0.35 });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xffedd5,
    emissive: 0xffb347,
    emissiveIntensity: 2.8,
  });

  // Base pedestal + tall mast
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.7, 10), poleMat);
  base.position.y = 0.35;
  root.add(base);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.13, 8.6, 10), poleMat);
  pole.position.y = 4.6;
  pole.castShadow = true;
  root.add(pole);

  // Cantilevered arm reaching toward boulevard center
  const dir = side < 0 ? 1 : -1;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.1, 0.1), poleMat);
  arm.position.set(dir * 1.05, 8.85, 0);
  arm.rotation.z = dir * 0.14;
  root.add(arm);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.14, 0.32), poleMat);
  head.position.set(dir * 2.05, 9.0, 0);
  root.add(head);

  const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.24), bulbMat);
  bulb.position.set(dir * 2.05, 8.92, 0);
  root.add(bulb);

  if (withBanner) {
    const bannerMat = new THREE.MeshStandardMaterial({
      map: textures.bannerMap,
      roughness: 0.65,
      side: THREE.DoubleSide,
    });
    const rodTop = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.05, 8), poleMat);
    rodTop.rotation.z = Math.PI / 2;
    rodTop.position.set(dir * 0.56, 7.05, 0);
    const rodBot = rodTop.clone();
    rodBot.position.y = 4.85;
    root.add(rodTop, rodBot);

    const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 2.15), bannerMat);
    banner.position.set(dir * 0.56, 5.95, 0);
    root.add(banner);
  }

  return root;
}

function createHelicopterGroup() {
  const root = new THREE.Group();
  const hullMat = new THREE.MeshPhysicalMaterial({
    color: 0x1e2530,
    metalness: 0.65,
    roughness: 0.28,
    clearcoat: 0.7,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    metalness: 0.85,
    roughness: 0.1,
  });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x0f1218, roughness: 0.5, metalness: 0.4 });
  const strobeMat = new THREE.MeshStandardMaterial({
    color: 0xff3b3b,
    emissive: 0xff2222,
    emissiveIntensity: 3.0,
  });

  // Fuselage
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.25, 3.6), hullMat);
  root.add(body);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 10), glassMat);
  canopy.scale.set(0.85, 0.72, 1.15);
  canopy.position.set(0, 0.05, -1.3);
  root.add(canopy);

  const tailBoom = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.36, 4.2), hullMat);
  tailBoom.position.set(0, 0.2, 3.4);
  root.add(tailBoom);

  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.05, 0.65), hullMat);
  tailFin.position.set(0, 0.65, 5.2);
  root.add(tailFin);

  // Landing skids
  [-0.75, 0.75].forEach((sx) => {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 8), rotorMat);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(sx, -0.92, -0.2);
    root.add(skid);
  });

  // Main Rotor
  const mainRotor = new THREE.Group();
  mainRotor.position.set(0, 0.85, 0);
  const bladeA = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.05, 0.28), rotorMat);
  const bladeB = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 8.8), rotorMat);
  mainRotor.add(bladeA, bladeB);
  root.add(mainRotor);

  // Tail Rotor
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.18, 0.65, 5.3);
  const tbA = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.5, 0.14), rotorMat);
  const tbB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 1.5), rotorMat);
  tailRotor.add(tbA, tbB);
  root.add(tailRotor);

  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), strobeMat);
  strobe.position.set(0, -0.65, 0.4);
  root.add(strobe);

  // Searchlight cone (visible when player has wanted stars)
  const coneGeo = new THREE.ConeGeometry(8, 38, 18, 1, true);
  coneGeo.translate(0, -19, 0);
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0xfff6d1,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const searchlight = new THREE.Mesh(coneGeo, coneMat);
  searchlight.position.set(0, -0.5, -1.2);
  searchlight.visible = false;
  root.add(searchlight);

  root.userData.heliRig = { mainRotor, tailRotor, strobeMat, searchlight };
  return root;
}

// ============================================================================
// 5. SUNSET SKY SHADER & WORLD BUILDER
// ============================================================================
function createSunsetSky() {
  const skyGeo = new THREE.SphereGeometry(520, 32, 24);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(-0.04, 0.13, -0.99).normalize() },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldDir;
      uniform vec3 uSunDir;
      uniform float uTime;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p);
          p *= 2.04;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vWorldDir);
        float h = clamp(d.y, 0.0, 1.0);

        // Golden-hour sunset sky gradient matching Los Santos dusk
        vec3 horizon = vec3(0.98, 0.63, 0.40);
        vec3 midSky = vec3(0.84, 0.52, 0.50);
        vec3 zenith = vec3(0.28, 0.43, 0.62);

        vec3 col = mix(horizon, midSky, smoothstep(0.0, 0.28, h));
        col = mix(col, zenith, smoothstep(0.24, 0.85, h));

        // Sun glow & blazing solar disc low between towers
        float sunDot = max(dot(d, normalize(uSunDir)), 0.0);
        col += vec3(1.0, 0.68, 0.34) * pow(sunDot, 7.0) * 0.55;
        col += vec3(1.0, 0.90, 0.72) * pow(sunDot, 64.0) * 0.9;
        col += vec3(1.0, 0.98, 0.90) * smoothstep(0.9985, 0.9996, sunDot) * 1.8;

        // Soft wispy golden-lit clouds
        if (d.y > 0.03) {
          vec2 uv = d.xz / (d.y + 0.16) * 1.4 + vec2(uTime * 0.008, 0.0);
          float cl = fbm(uv * 1.7);
          float cloudMask = smoothstep(0.48, 0.78, cl) * smoothstep(0.03, 0.25, d.y);
          vec3 cloudDark = vec3(0.42, 0.46, 0.58);
          vec3 cloudLit = mix(vec3(0.98, 0.68, 0.45), vec3(1.0, 0.88, 0.68), pow(sunDot, 3.0));
          vec3 cloudCol = mix(cloudDark, cloudLit, 0.48 + 0.52 * pow(sunDot, 2.0));
          col = mix(col, cloudCol, cloudMask * 0.62);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(skyGeo, skyMat);
}

function buildCityWorld(scene, textures, isSoftwareGl) {
  const colliders = []; // { minX, maxX, minZ, maxZ, label }
  const sidewalkLights = [];

  // 1. Extended Base Ground (prevents any void edges)
  const outerGroundMat = new THREE.MeshStandardMaterial({ color: 0x202228, roughness: 0.9 });
  const outerGround = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), outerGroundMat);
  outerGround.rotation.x = -Math.PI / 2;
  outerGround.position.y = -0.02;
  outerGround.receiveShadow = true;
  scene.add(outerGround);

  // 2. Main Boulevard Wet-Look Asphalt Road (Y = 0)
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textures.roadMap,
    roughnessMap: textures.roadRoughnessMap,
    roughness: 0.72,
    metalness: 0.12,
    envMapIntensity: 1.35,
  });
  const mainRoad = new THREE.Mesh(new THREE.PlaneGeometry(WORLD.roadHalfWidth * 2, 340), roadMat);
  mainRoad.rotation.x = -Math.PI / 2;
  mainRoad.position.set(0, 0, -10);
  mainRoad.receiveShadow = true;
  scene.add(mainRoad);

  // Cross Streets at Z = -60, Z = +15, Z = +90
  const crossMat = new THREE.MeshStandardMaterial({
    color: 0x262930,
    roughnessMap: textures.roadRoughnessMap,
    roughness: 0.75,
    metalness: 0.1,
  });
  [-65, 80].forEach((cz) => {
    const cross = new THREE.Mesh(new THREE.PlaneGeometry(240, 18), crossMat);
    cross.rotation.x = -Math.PI / 2;
    cross.position.set(0, 0.008, cz);
    cross.receiveShadow = true;
    scene.add(cross);
  });

  // 3. Tiled Sidewalks + Red Curbs (offset Y = 0.08 to 0.16, zero Z-fighting)
  const swMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textures.sidewalkMap,
    bumpMap: textures.sidewalkBumpMap,
    bumpScale: 0.025,
    roughness: 0.42,
    metalness: 0.08,
    envMapIntensity: 1.15,
  });
  const redCurbMat = new THREE.MeshStandardMaterial({ color: 0xb92b27, roughness: 0.58 });
  const greyCurbMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.72 });

  [-1, 1].forEach((side) => {
    const swX = side * (WORLD.roadHalfWidth + WORLD.sidewalkWidth * 0.5);
    const sw = new THREE.Mesh(new THREE.BoxGeometry(WORLD.sidewalkWidth, WORLD.sidewalkHeight, 340), swMat);
    sw.position.set(swX, WORLD.sidewalkHeight * 0.5, -10);
    sw.receiveShadow = true;
    scene.add(sw);

    // Painted curb edge (red along the City Mall & right foreground just like screenshot)
    const curbX = side * (WORLD.roadHalfWidth + 0.16);
    const redCurb = new THREE.Mesh(new THREE.BoxGeometry(0.32, WORLD.sidewalkHeight + 0.02, 120), redCurbMat);
    redCurb.position.set(curbX, WORLD.sidewalkHeight * 0.5 + 0.01, 20);
    redCurb.receiveShadow = true;
    scene.add(redCurb);

    const farCurb = new THREE.Mesh(new THREE.BoxGeometry(0.32, WORLD.sidewalkHeight + 0.015, 220), greyCurbMat);
    farCurb.position.set(curbX, WORLD.sidewalkHeight * 0.5 + 0.005, -120);
    scene.add(farCurb);
  });

  // 4. LOS SANTOS CITY MALL (Hero Left Architectural Landmark)
  const mallGroup = new THREE.Group();
  const mallX = -26.5;
  const mallZ = 6;
  const mallW = 14.5;
  const mallH = 12.2;
  const mallD = 48;

  const mallFrontMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textures.mallMap,
    emissive: 0xffd599,
    emissiveMap: textures.mallEmissiveMap,
    emissiveIntensity: 0.92,
    roughness: 0.25,
    metalness: 0.18,
  });
  const mallSideMat = new THREE.MeshStandardMaterial({ color: 0x9b8e80, roughness: 0.7 });
  const mallRoofMat = new THREE.MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.85 });

  // Multi-material box: +X faces the boulevard!
  const mallMesh = new THREE.Mesh(new THREE.BoxGeometry(mallW, mallH, mallD), [
    mallFrontMat, // +X (boulevard facing!)
    mallSideMat,  // -X
    mallRoofMat,  // +Y
    mallRoofMat,  // -Y
    mallSideMat,  // +Z
    mallSideMat,  // -Z
  ]);
  mallMesh.position.set(mallX, mallH * 0.5, mallZ);
  mallMesh.castShadow = true;
  mallMesh.receiveShadow = true;
  mallGroup.add(mallMesh);

  // Overhanging illuminated entrance canopy
  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.55, 22),
    new THREE.MeshStandardMaterial({ color: 0x262930, roughness: 0.4, metalness: 0.5 })
  );
  canopy.position.set(mallX + mallW * 0.5 + 1.4, 4.65, mallZ);
  canopy.castShadow = true;
  mallGroup.add(canopy);

  // Glowing golden entrance marker ring on sidewalk
  const markerRing = new THREE.Mesh(
    new THREE.RingGeometry(1.15, 1.45, 28),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, side: THREE.DoubleSide })
  );
  markerRing.rotation.x = -Math.PI / 2;
  markerRing.position.set(WORLD.mallZone.x, WORLD.sidewalkHeight + 0.03, WORLD.mallZone.z);
  mallGroup.add(markerRing);

  // Warm interior spill light on mall sidewalk (skip extra point lights on software GL? Keep 2 key warm pools)
  if (!isSoftwareGl) {
    const mallLight = new THREE.PointLight(0xffb457, 14, 24, 1.7);
    mallLight.position.set(-16.5, 4.2, 14);
    scene.add(mallLight);
    sidewalkLights.push(mallLight);
  }

  scene.add(mallGroup);
  colliders.push({
    minX: mallX - mallW * 0.5,
    maxX: mallX + mallW * 0.5,
    minZ: mallZ - mallD * 0.5,
    maxZ: mallZ + mallD * 0.5,
    label: 'City Mall',
  });

  // 5. Right-Side Commercial Building + Giant "LOS SANTOS" Billboard
  const rightBuildingGroup = new THREE.Group();
  const rbX = 30;
  const rbZ = -34;
  const rbW = 24;
  const rbH = 15.5;
  const rbD = 30;
  const rbMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textures.towerC.map,
    emissive: 0xffffff,
    emissiveMap: textures.towerC.emissiveMap,
    emissiveIntensity: 0.72,
    roughness: 0.45,
    metalness: 0.35,
  });
  const rbMesh = new THREE.Mesh(new THREE.BoxGeometry(rbW, rbH, rbD), rbMat);
  rbMesh.position.set(rbX, rbH * 0.5, rbZ);
  rbMesh.castShadow = true;
  rbMesh.receiveShadow = true;
  rightBuildingGroup.add(rbMesh);

  // Rooftop Billboard facing the player (+Z / slightly angled toward boulevard)
  const bbGroup = new THREE.Group();
  bbGroup.position.set(rbX - 1.5, rbH + 6.2, rbZ + 4);
  bbGroup.rotation.y = -0.34;
  const bbFace = new THREE.Mesh(
    new THREE.BoxGeometry(20, 10, 0.8),
    [
      new THREE.MeshStandardMaterial({ color: 0x181c24 }),
      new THREE.MeshStandardMaterial({ color: 0x181c24 }),
      new THREE.MeshStandardMaterial({ color: 0x181c24 }),
      new THREE.MeshStandardMaterial({ color: 0x181c24 }),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: textures.billboardMap,
        emissive: 0xdbeafe,
        emissiveMap: textures.billboardMap,
        emissiveIntensity: 0.35,
        roughness: 0.4,
      }),
      new THREE.MeshStandardMaterial({ color: 0x181c24 }),
    ]
  );
  bbGroup.add(bbFace);
  // Steel billboard struts
  [-6.5, 6.5].forEach((sx) => {
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.32, 3.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x22262e, metalness: 0.7, roughness: 0.4 })
    );
    strut.position.set(sx, -5.8, 0);
    bbGroup.add(strut);
  });
  rightBuildingGroup.add(bbGroup);
  scene.add(rightBuildingGroup);

  colliders.push({
    minX: rbX - rbW * 0.5,
    maxX: rbX + rbW * 0.5,
    minZ: rbZ - rbD * 0.5,
    maxZ: rbZ + rbD * 0.5,
    label: 'Billboard Plaza',
  });

  // Safe House Marker on right sidewalk near Billboard Plaza
  const safeRing = new THREE.Mesh(
    new THREE.RingGeometry(1.15, 1.48, 28),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide })
  );
  safeRing.rotation.x = -Math.PI / 2;
  safeRing.position.set(WORLD.safeHouseZone.x, WORLD.sidewalkHeight + 0.03, WORLD.safeHouseZone.z);
  scene.add(safeRing);

  // 6. Elevated Highway Overpass Crossing the Boulevard (Z = -56)
  const overpassGroup = new THREE.Group();
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x565a62, roughness: 0.85, metalness: 0.05 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(220, 1.8, 13.5), concreteMat);
  deck.position.set(0, 9.2, -56);
  deck.castShadow = true;
  deck.receiveShadow = true;
  overpassGroup.add(deck);

  const rail = new THREE.Mesh(new THREE.BoxGeometry(220, 1.1, 0.6), concreteMat);
  rail.position.set(0, 10.6, -56 + 6.4);
  const railBack = rail.clone();
  railBack.position.z = -56 - 6.4;
  overpassGroup.add(rail, railBack);

  [-26, -15, 15, 28, -58, 58].forEach((px) => {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(2.6, 9.0, 3.2), concreteMat);
    pier.position.set(px, 4.5, -56);
    pier.castShadow = true;
    overpassGroup.add(pier);
    colliders.push({
      minX: px - 1.3,
      maxX: px + 1.3,
      minZ: -57.6,
      maxZ: -54.4,
      label: 'Overpass Pier',
    });
  });
  scene.add(overpassGroup);

  // 7. Downtown Skyscraper Skyline (Maze Bank-style stepped centerpiece + surrounding towers)
  const towerStyles = [textures.towerA, textures.towerB, textures.towerC];

  // Hero Tallest Stepped Cylindrical/Chamfered Tower (Maze Bank silhouette)
  const heroTower = new THREE.Group();
  heroTower.position.set(11, 0, -138);
  const heroMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textures.towerA.map,
    emissive: 0xffffff,
    emissiveMap: textures.towerA.emissiveMap,
    emissiveIntensity: 0.68,
    roughness: 0.28,
    metalness: 0.55,
  });
  const baseBlock = new THREE.Mesh(new THREE.CylinderGeometry(13.5, 14.5, 92, 12), heroMat);
  baseBlock.position.y = 46;
  const midBlock = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 12.2, 24, 12), heroMat);
  midBlock.position.y = 104;
  const crownBlock = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 9.2, 14, 12), heroMat);
  crownBlock.position.y = 123;
  const spire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.9, 14, 8),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.85, roughness: 0.2 })
  );
  spire.position.y = 136;
  heroTower.add(baseBlock, midBlock, crownBlock, spire);
  scene.add(heroTower);

  // Surrounding Downtown & Side-Block Skyscrapers
  const buildingSpecs = [
    // Far downtown skyline cluster (left, center, right)
    { x: -34, z: -125, w: 22, h: 78, d: 22, style: 0 },
    { x: -16, z: -146, w: 20, h: 98, d: 20, style: 1 },
    { x: 36, z: -130, w: 26, h: 92, d: 24, style: 2 },
    { x: 58, z: -115, w: 22, h: 66, d: 24, style: 0 },
    { x: -58, z: -110, w: 24, h: 62, d: 24, style: 2 },
    { x: -24, z: -96, w: 18, h: 48, d: 18, style: 1 },
    { x: 32, z: -94, w: 20, h: 52, d: 20, style: 0 },
    // Mid-block buildings framing the sides & right horizon
    { x: -32, z: -34, w: 20, h: 28, d: 28, style: 1 },
    { x: -32, z: 54, w: 20, h: 24, d: 26, style: 2 },
    { x: 56, z: -34, w: 22, h: 24, d: 34, style: 0 },
    { x: 60, z: -76, w: 24, h: 40, d: 28, style: 2 },
    { x: 46, z: 48, w: 20, h: 18, d: 28, style: 1 },
    { x: -34, z: 108, w: 22, h: 30, d: 30, style: 0 },
    { x: 34, z: 112, w: 22, h: 34, d: 30, style: 2 },
  ];

  buildingSpecs.forEach((b) => {
    const st = towerStyles[b.style];
    const bMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: st.map,
      emissive: 0xffffff,
      emissiveMap: st.emissiveMap,
      emissiveIntensity: 0.65,
      roughness: 0.34,
      metalness: 0.45,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), bMat);
    mesh.position.set(b.x, b.h * 0.5, b.z);
    mesh.castShadow = b.z > -90;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Rooftop mechanical penthouse for multi-part silhouette
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(b.w * 0.58, 3.2, b.d * 0.58),
      new THREE.MeshStandardMaterial({ color: 0x262b35, roughness: 0.75 })
    );
    cap.position.set(b.x, b.h + 1.6, b.z);
    scene.add(cap);

    if (Math.abs(b.z) < 120) {
      colliders.push({
        minX: b.x - b.w * 0.5,
        maxX: b.x + b.w * 0.5,
        minZ: b.z - b.d * 0.5,
        maxZ: b.z + b.d * 0.5,
        label: 'Building',
      });
    }
  });

  // 8. California Palm Trees & Streetlight Poles with Purple Banners
  const palmPositions = [
    [-12.8, 30, 1.05, -1],
    [-12.8, 12, 0.96, 1],
    [-12.8, -6, 1.08, -1],
    [-12.8, -26, 0.98, 1],
    [-12.8, -72, 1.04, -1],
    [-12.8, 52, 0.95, 1],
    [12.8, 22, 1.06, 1],
    [12.8, 2, 0.96, -1],
    [12.8, -18, 1.02, 1],
    [12.8, -40, 0.94, -1],
    [12.8, -74, 1.05, 1],
    [12.8, 56, 1.0, -1],
  ];
  palmPositions.forEach(([px, pz, scale, lean]) => {
    const palm = createPalmTreeGroup(textures, scale, lean);
    palm.position.set(px, WORLD.sidewalkHeight, pz);
    scene.add(palm);
    colliders.push({
      minX: px - 0.42,
      maxX: px + 0.42,
      minZ: pz - 0.42,
      maxZ: pz + 0.42,
      label: 'Palm Tree',
    });
  });

  const lampPositions = [
    [-12.4, 21, -1, true],
    [-12.4, -15, -1, true],
    [-12.4, -44, -1, false],
    [-12.4, 46, -1, true],
    [12.4, 13, 1, true],
    [12.4, -27, 1, true],
    [12.4, 42, 1, false],
    [12.4, -70, 1, true],
  ];
  lampPositions.forEach(([lx, lz, side, banner]) => {
    const lamp = createStreetLampGroup(textures, side, banner);
    lamp.position.set(lx, WORLD.sidewalkHeight, lz);
    scene.add(lamp);
  });

  // Sidewalk Planters outside City Mall
  const planterMat = new THREE.MeshStandardMaterial({ color: 0x45433f, roughness: 0.8 });
  const shrubMat = new THREE.MeshStandardMaterial({ color: 0x385726, roughness: 0.78 });
  [-17.5, -17.5, -17.5].forEach((px, idx) => {
    const pz = -8 + idx * 18;
    const pot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.65, 2.2), planterMat);
    pot.position.set(px, WORLD.sidewalkHeight + 0.325, pz);
    const bush = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8), shrubMat);
    bush.scale.set(0.9, 1.05, 1.25);
    bush.position.set(px, WORLD.sidewalkHeight + 0.95, pz);
    scene.add(pot, bush);
  });

  return { colliders, markerRing, safeRing };
}

// ============================================================================
// 6. MAIN GAME APPLICATION
// ============================================================================
function initGame() {
  const mount = document.getElementById('canvas-mount');
  const minimapCanvas = document.getElementById('minimap-canvas');
  const minimapCtx = minimapCanvas.getContext('2d');
  const fullmapCanvas = document.getElementById('fullmap-canvas');
  const fullmapCtx = fullmapCanvas.getContext('2d');

  // Software-WebGL probe (SwiftShader / llvmpipe / WARP)
  const isSoftwareGl = (() => {
    try {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return true;
      const ext = probe.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
      const gpu = String(probe.getParameter(param) || '');
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      return true;
    }
  })();

  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd88862, 0.0024);

  const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.15, 650);
  camera.position.set(14.35, 2.28, 41.4);
  camera.lookAt(7.5, 3.8, -28);

  // Studio + Golden Hour Environment Reflection Map
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  pmremGenerator.dispose();

  // Warm/Cool Sunset Lighting Rig
  const hemiLight = new THREE.HemisphereLight(0x8bb0de, 0x3b2a24, 0.72);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xffb56b, 1.85);
  sunLight.position.set(-14, 24, -75);
  if (!isSoftwareGl) {
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.near = 5;
    sunLight.shadow.camera.far = 180;
    const d = 55;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.02;
  }
  scene.add(sunLight);

  const fillLight = new THREE.DirectionalLight(0x7ca2d6, 0.45);
  fillLight.position.set(22, 18, 45);
  scene.add(fillLight);

  // Sky Dome
  const skyDome = createSunsetSky();
  scene.add(skyDome);

  // Procedural Textures & City World
  const maxAniso = isSoftwareGl ? 1 : renderer.capabilities.getMaxAnisotropy();
  const textures = createTextures(maxAniso);
  const { colliders, markerRing, safeRing } = buildCityWorld(scene, textures, isSoftwareGl);

  // Flying Police/News Helicopter
  const helicopter = createHelicopterGroup();
  helicopter.position.set(24, 34, -72);
  scene.add(helicopter);

  // Protagonist Character
  const playerMesh = createCharacterGroup(textures, {
    shirtColor: 0x141b2d,
    pantsColor: 0x16181e,
    hasCap: true,
    hasStripe: true,
  });
  scene.add(playerMesh);

  // Drivable + Traffic Vehicles
  const vehicles = [];
  const vehicleSpecs = [
    // Foreground dark sports coupe matching screenshot
    { type: 'coupe', color: 0x12151c, x: 4.0, z: 18, yaw: 0, speed: 12, laneX: 4.0, dir: -1, parked: false },
    // Parked sports coupe on right side curb ready for easy player entry
    { type: 'coupe', color: 0x1f2430, x: 9.2, z: 33.8, yaw: 0, speed: 0, laneX: 9.2, dir: -1, parked: true },
    { type: 'sedan', color: 0x262932, x: -4.2, z: 4, yaw: Math.PI, speed: 11, laneX: -4.2, dir: 1, parked: false },
    { type: 'suv', color: 0x17191e, x: 7.5, z: -8, yaw: 0, speed: 10.5, laneX: 7.5, dir: -1, parked: false },
    { type: 'sedan', color: 0xb4bcc8, x: 9.0, z: 10, yaw: 0, speed: 11.5, laneX: 9.0, dir: -1, parked: false },
    { type: 'sedan', color: 0x8b2323, x: -7.8, z: -38, yaw: Math.PI, speed: 12, laneX: -7.8, dir: 1, parked: false },
    { type: 'suv', color: 0x2f3b4a, x: 3.8, z: -72, yaw: 0, speed: 12.5, laneX: 3.8, dir: -1, parked: false },
    { type: 'police', color: 0x11151d, x: -4.2, z: -92, yaw: Math.PI, speed: 13.5, laneX: -4.2, dir: 1, parked: false },
  ];

  vehicleSpecs.forEach((vs, idx) => {
    const mesh = createCarGroup(textures, { color: vs.color, type: vs.type });
    mesh.position.set(vs.x, 0, vs.z);
    mesh.rotation.y = vs.yaw;
    scene.add(mesh);
    vehicles.push({
      id: idx,
      mesh,
      type: vs.type,
      name:
        vs.type === 'coupe'
          ? 'Kuruma GT'
          : vs.type === 'suv'
          ? 'Granger SUV'
          : vs.type === 'police'
          ? 'LSPD Cruiser'
          : 'Tailgater Sedan',
      x: vs.x,
      z: vs.z,
      yaw: vs.yaw,
      speed: 0,
      aiSpeed: vs.speed,
      laneX: vs.laneX,
      dir: vs.dir,
      parked: vs.parked,
      occupiedByNpc: !vs.parked,
      driverControlled: false,
      steerAngle: 0,
    });
  });

  // Ambient Pedestrians strolling on sidewalks
  const pedestrians = [];
  const pedPresets = [
    { x: -16.8, z: 24, dir: 1, shirt: 0x4b5563, pants: 0x111827, cap: false },
    { x: -14.8, z: 18, dir: 1, shirt: 0x1f2937, pants: 0x3b6088, cap: false },
    { x: -16.2, z: 6, dir: 1, shirt: 0x1e293b, pants: 0x171717, cap: true },
    { x: -14.5, z: -2, dir: -1, shirt: 0x334155, pants: 0x1e293b, cap: false },
    { x: -16.0, z: -18, dir: 1, shirt: 0x7c2d12, pants: 0x1f2937, cap: false },
    { x: 15.8, z: 8, dir: 1, shirt: 0x1e3a5f, pants: 0x18181b, cap: true },
    { x: 14.2, z: -16, dir: -1, shirt: 0x374151, pants: 0x111827, cap: false },
    { x: 16.4, z: -42, dir: 1, shirt: 0x475569, pants: 0x1e293b, cap: false },
    { x: -15.2, z: -48, dir: -1, shirt: 0x27272a, pants: 0x334155, cap: true },
    { x: 15.0, z: 54, dir: -1, shirt: 0x3f3f46, pants: 0x171717, cap: false },
  ];
  pedPresets.forEach((pp) => {
    const mesh = createCharacterGroup(textures, {
      shirtColor: pp.shirt,
      pantsColor: pp.pants,
      hasCap: pp.cap,
      hasStripe: false,
    });
    mesh.position.set(pp.x, WORLD.sidewalkHeight, pp.z);
    mesh.rotation.y = pp.dir > 0 ? Math.PI : 0;
    scene.add(mesh);
    pedestrians.push({
      mesh,
      x: pp.x,
      z: pp.z,
      dir: pp.dir,
      speed: 1.7 + Math.random() * 0.7,
      walkPhase: Math.random() * Math.PI * 2,
      stunTimer: 0,
    });
  });

  // Street Cash Pickups ($500 - $1500)
  const pickups = [];
  const pickupSpots = [
    { x: -15.2, z: 28, value: 500 },
    { x: -15.2, z: -12, value: 750 },
    { x: 15.5, z: -6, value: 500 },
    { x: 0, z: -40, value: 1200 },
    { x: 16.5, z: -68, value: 1000 },
    { x: -15.5, z: -85, value: 1500 },
    { x: 14.5, z: 62, value: 750 },
  ];
  const pickupGeo = new THREE.OctahedronGeometry(0.42, 0);
  const pickupMat = new THREE.MeshStandardMaterial({
    color: 0x4ade80,
    emissive: 0x22c55e,
    emissiveIntensity: 1.5,
    metalness: 0.4,
    roughness: 0.2,
  });
  pickupSpots.forEach((ps) => {
    const mesh = new THREE.Mesh(pickupGeo, pickupMat);
    const baseY = Math.abs(ps.x) > WORLD.roadHalfWidth ? WORLD.sidewalkHeight + 0.95 : 0.95;
    mesh.position.set(ps.x, baseY, ps.z);
    scene.add(mesh);
    pickups.push({ ...ps, baseY, mesh, cooldown: 0 });
  });

  // ============================================================================
  // 7. GAME STATE & INPUT HUB
  // ============================================================================
  const sound = new SoundEngine();

  const state = {
    mode: 'title', // 'title' | 'playing' | 'paused'
    cash: START_CASH,
    hp: 100,
    armor: 65,
    stamina: 100,
    wanted: 0,
    wantedTimer: 0,
    sprintBonus: 1.0,
    player: {
      x: 13.8,
      y: WORLD.sidewalkHeight,
      z: 36,
      vy: 0,
      yaw: 0,
      onGround: true,
      walkPhase: 0,
      punchTimer: 0,
      inVehicle: null,
    },
    cameraYaw: 0.14,
    cameraPitch: 0.05,
    cameraDist: 4.9,
    cameraCurPos: new THREE.Vector3(14.35, 2.28, 41.4),
    cameraCurLook: new THREE.Vector3(7.5, 3.8, -28),
    waypoint: null,
    sprintToggle: false,
    modalOpen: null, // 'map' | 'mall' | null
    toastTimer: 0,
    trauma: 0,
    lastMinimapTime: 0,
  };

  // DOM References
  const el = {
    cash: document.getElementById('cash-display'),
    stars: Array.from(document.querySelectorAll('#wanted-stars .star-icon')),
    minimapHp: document.getElementById('minimap-hp-fill'),
    minimapArmor: document.getElementById('minimap-armor-fill'),
    minimapStamina: document.getElementById('minimap-stamina-fill'),
    vitalHp: document.getElementById('vital-hp-fill'),
    vitalArmor: document.getElementById('vital-armor-fill'),
    vitalStamina: document.getElementById('vital-stamina-fill'),
    btnStart: document.getElementById('btn-start'),
    btnOpenMap: document.getElementById('btn-open-map'),
    btnCloseMap: document.getElementById('btn-close-map'),
    btnCloseMall: document.getElementById('btn-close-mall'),
    btnCar: document.getElementById('btn-car'),
    btnSprint: document.getElementById('btn-sprint'),
    btnJump: document.getElementById('btn-jump'),
    btnWeapon: document.getElementById('btn-weapon-slot'),
    btnMute: document.getElementById('btn-mute'),
    btnPause: document.getElementById('btn-pause'),
    btnResume: document.getElementById('btn-resume'),
    btnRestart: document.getElementById('btn-restart'),
    btnToTitle: document.getElementById('btn-to-title'),
    iconSoundOn: document.getElementById('icon-sound-on'),
    iconSoundOff: document.getElementById('icon-sound-off'),
    speedBadge: document.getElementById('speedometer-badge'),
    speedValue: document.getElementById('speed-value'),
    prompt: document.getElementById('interaction-prompt'),
    toast: document.getElementById('toast-banner'),
    mapModal: document.getElementById('map-modal'),
    mallModal: document.getElementById('mall-modal'),
    pauseModal: document.getElementById('pause-modal'),
    mallCash: document.getElementById('mall-cash-readout'),
    pauseCash: document.getElementById('pause-cash'),
    pauseWanted: document.getElementById('pause-wanted'),
    joyZone: document.getElementById('joystick-zone'),
    joyKnob: document.getElementById('joystick-knob'),
  };

  const keys = new Set();
  const joystick = { active: false, pointerId: null, dx: 0, dy: 0 };
  const dragLook = { active: false, lastX: 0, lastY: 0 };

  function showToast(msg, duration = 2.6) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    state.toastTimer = duration;
  }

  function updateHudDom() {
    el.cash.textContent = formatCash(state.cash);
    el.mallCash.textContent = formatCash(state.cash);
    el.minimapHp.style.width = `${clamp(state.hp, 0, 100)}%`;
    el.vitalHp.style.width = `${clamp(state.hp, 0, 100)}%`;
    el.minimapArmor.style.width = `${clamp(state.armor, 0, 100)}%`;
    el.vitalArmor.style.width = `${clamp(state.armor, 0, 100)}%`;
    el.minimapStamina.style.width = `${clamp(state.stamina, 0, 100)}%`;
    el.vitalStamina.style.width = `${clamp(state.stamina, 0, 100)}%`;
  }

  function setMode(nextMode) {
    state.mode = nextMode;
    document.body.dataset.state = nextMode;
    if (nextMode === 'paused') {
      el.pauseCash.textContent = '$' + state.cash.toLocaleString('en-US');
      el.pauseWanted.textContent = `${state.wanted} ★`;
      if (!el.pauseModal.open) el.pauseModal.showModal();
      sound.updateEngine(false, 0);
    } else {
      if (el.pauseModal.open) el.pauseModal.close();
    }
    if (nextMode !== 'playing') {
      keys.clear();
      joystick.dx = 0;
      joystick.dy = 0;
      el.joyKnob.style.transform = 'translate(0px, 0px)';
    }
  }

  function startGame() {
    sound.unlock();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setMode('playing');
    updateHudDom();
  }

  function resetWorld() {
    state.cash = START_CASH;
    state.hp = 100;
    state.armor = 65;
    state.stamina = 100;
    state.wanted = 0;
    state.wantedTimer = 0;
    state.sprintBonus = 1.0;
    state.waypoint = null;
    if (state.player.inVehicle) {
      state.player.inVehicle.driverControlled = false;
      state.player.inVehicle = null;
    }
    state.player.x = 13.8;
    state.player.y = WORLD.sidewalkHeight;
    state.player.z = 36;
    state.player.vy = 0;
    state.player.yaw = 0;
    state.player.onGround = true;
    state.cameraYaw = 0.14;
    state.cameraPitch = 0.05;
    state.cameraDist = 4.9;
    state.cameraCurPos.set(14.35, 2.28, 41.4);
    state.cameraCurLook.set(7.5, 3.8, -28);
    el.speedBadge.hidden = true;
    updateHudDom();
  }

  function toggleMapModal() {
    if (state.mode !== 'playing') return;
    if (state.modalOpen === 'map') {
      el.mapModal.close();
      state.modalOpen = null;
    } else {
      if (state.modalOpen === 'mall') el.mallModal.close();
      state.modalOpen = 'map';
      el.mapModal.showModal();
      drawFullMap();
    }
  }

  function toggleMallModal() {
    if (state.mode !== 'playing') return;
    if (state.modalOpen === 'mall') {
      el.mallModal.close();
      state.modalOpen = null;
    } else {
      if (state.modalOpen === 'map') el.mapModal.close();
      state.modalOpen = 'mall';
      el.mallModal.showModal();
    }
  }

  function addWantedStar(amount = 1) {
    state.wanted = clamp(state.wanted + amount, 0, 5);
    state.wantedTimer = 18;
  }

  function getNearestEnterableVehicle() {
    let best = null;
    let bestDist = 5.6;
    for (const v of vehicles) {
      const d = Math.hypot(v.x - state.player.x, v.z - state.player.z);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  function toggleVehicle() {
    if (state.mode !== 'playing' || state.modalOpen) return;
    sound.unlock();
    if (state.player.inVehicle) {
      const car = state.player.inVehicle;
      car.driverControlled = false;
      car.parked = true;
      state.player.inVehicle = null;
      // Step out to left side of car
      const sideX = -Math.cos(car.yaw) * 1.9;
      const sideZ = Math.sin(car.yaw) * 1.9;
      state.player.x = car.x + sideX;
      state.player.z = car.z + sideZ;
      state.player.y = groundHeightAt(state.player.x, state.player.z);
      state.player.yaw = car.yaw;
      playerMesh.visible = true;
      el.speedBadge.hidden = true;
      sound.playCarDoor();
      sound.updateEngine(false, 0);
    } else {
      const target = getNearestEnterableVehicle();
      if (!target) {
        showToast('Walk closer to a car to enter it');
        return;
      }
      if (target.occupiedByNpc) {
        target.occupiedByNpc = false;
        addWantedStar(1);
        showToast(`Hijacked ${target.name} · +1 Wanted Star`);
      } else {
        showToast(`Driving ${target.name}`);
      }
      target.driverControlled = true;
      target.parked = false;
      state.player.inVehicle = target;
      playerMesh.visible = false;
      el.speedBadge.hidden = false;
      sound.playCarDoor();
    }
  }

  function triggerJump() {
    if (state.mode !== 'playing' || state.modalOpen) return;
    sound.unlock();
    if (!state.player.inVehicle && state.player.onGround) {
      state.player.vy = 7.4;
      state.player.onGround = false;
      sound.playJump();
    }
  }

  function triggerPunch() {
    if (state.mode !== 'playing' || state.modalOpen || state.player.inVehicle) return;
    if (state.player.punchTimer > 0) return;
    sound.unlock();
    state.player.punchTimer = 0.34;
    sound.playPunch();

    // Check pedestrian hit
    const fx = -Math.sin(state.player.yaw);
    const fz = -Math.cos(state.player.yaw);
    for (const ped of pedestrians) {
      const dx = ped.x - state.player.x;
      const dz = ped.z - state.player.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.9 && dx * fx + dz * fz > 0.2) {
        ped.stunTimer = 2.0;
        state.cash += 150;
        addWantedStar(1);
        state.trauma = Math.min(1, state.trauma + 0.25);
        showToast('Street scuffle +$150 · +1 Wanted Star');
        updateHudDom();
        break;
      }
    }
  }

  function groundHeightAt(x, z) {
    // Sidewalk raised along boulevard edges
    if (Math.abs(x) >= WORLD.roadHalfWidth && Math.abs(z - 80) > 9 && Math.abs(z + 65) > 9) {
      return WORLD.sidewalkHeight;
    }
    return 0;
  }

  function resolvesCollisions(x, z, radius) {
    let rx = clamp(x, -WORLD.bounds, WORLD.bounds);
    let rz = clamp(z, -WORLD.bounds, WORLD.bounds);
    let hit = false;
    for (const c of colliders) {
      const cx = clamp(rx, c.minX, c.maxX);
      const cz = clamp(rz, c.minZ, c.maxZ);
      const dx = rx - cx;
      const dz = rz - cz;
      const distSq = dx * dx + dz * dz;
      if (distSq < radius * radius) {
        hit = true;
        const dist = Math.sqrt(distSq) || 0.001;
        const push = radius - dist;
        if (dist > 0.001) {
          rx += (dx / dist) * push;
          rz += (dz / dist) * push;
        } else {
          // Inside box fallback: push out along nearest edge
          const dLeft = Math.abs(rx - c.minX);
          const dRight = Math.abs(c.maxX - rx);
          const dTop = Math.abs(rz - c.minZ);
          const dBot = Math.abs(c.maxZ - rz);
          const m = Math.min(dLeft, dRight, dTop, dBot);
          if (m === dLeft) rx = c.minX - radius;
          else if (m === dRight) rx = c.maxX + radius;
          else if (m === dTop) rz = c.minZ - radius;
          else rz = c.maxZ + radius;
        }
      }
    }
    return { x: rx, z: rz, hit };
  }

  // ============================================================================
  // 8. INPUT LISTENERS (Keyboard, Mouse Orbit, Virtual Joystick, HUD Buttons)
  // ============================================================================
  window.addEventListener('keydown', (e) => {
    const code = e.code;
    if (state.mode === 'title') {
      if (code === 'Enter' || code === 'Space') {
        e.preventDefault();
        startGame();
      }
      return;
    }

    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      if (state.modalOpen === 'map') toggleMapModal();
      else if (state.modalOpen === 'mall') toggleMallModal();
      else if (state.mode === 'playing') setMode('paused');
      else if (state.mode === 'paused') setMode('playing');
      return;
    }

    if (state.mode !== 'playing') return;

    if (code === 'KeyM') {
      e.preventDefault();
      toggleMapModal();
      return;
    }
    if (code === 'KeyE') {
      const distMall = Math.hypot(state.player.x - WORLD.mallZone.x, state.player.z - WORLD.mallZone.z);
      if (distMall < WORLD.mallZone.radius && !state.player.inVehicle) {
        toggleMallModal();
      }
      return;
    }
    if (code === 'KeyF') {
      e.preventDefault();
      toggleVehicle();
      return;
    }
    if (code === 'KeyN') {
      el.btnMute.click();
      return;
    }
    if (code === 'Space' && !e.repeat) {
      if (!state.player.inVehicle) {
        e.preventDefault();
        triggerJump();
      }
    }

    keys.add(code);
  });

  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });

  window.addEventListener('blur', () => {
    keys.clear();
    dragLook.active = false;
  });

  // Mouse Drag Camera Orbit on Canvas
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (state.mode !== 'playing' || state.modalOpen) return;
    sound.unlock();
    dragLook.active = true;
    dragLook.lastX = e.clientX;
    dragLook.lastY = e.clientY;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragLook.active) return;
    const dx = e.clientX - dragLook.lastX;
    const dy = e.clientY - dragLook.lastY;
    dragLook.lastX = e.clientX;
    dragLook.lastY = e.clientY;
    state.cameraYaw -= dx * 0.0055;
    state.cameraPitch = clamp(state.cameraPitch + dy * 0.004, -0.15, 0.72);
  });
  window.addEventListener('mouseup', () => {
    dragLook.active = false;
  });

  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      if (state.mode !== 'playing') return;
      state.cameraDist = clamp(state.cameraDist + e.deltaY * 0.004, 3.4, 10.5);
    },
    { passive: true }
  );

  // Virtual Analog Stick
  function updateJoystickFromPointer(clientX, clientY) {
    const rect = el.joyZone.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const maxR = rect.width * 0.34;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > maxR) {
      dx = (dx / len) * maxR;
      dy = (dy / len) * maxR;
    }
    joystick.dx = dx / maxR;
    joystick.dy = dy / maxR;
    el.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  el.joyZone.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'playing') return;
    sound.unlock();
    joystick.active = true;
    joystick.pointerId = e.pointerId;
    el.joyZone.setPointerCapture(e.pointerId);
    updateJoystickFromPointer(e.clientX, e.clientY);
  });
  el.joyZone.addEventListener('pointermove', (e) => {
    if (!joystick.active || e.pointerId !== joystick.pointerId) return;
    updateJoystickFromPointer(e.clientX, e.clientY);
  });
  const resetJoystick = (e) => {
    if (!joystick.active || (e && e.pointerId !== joystick.pointerId)) return;
    joystick.active = false;
    joystick.pointerId = null;
    joystick.dx = 0;
    joystick.dy = 0;
    el.joyKnob.style.transform = 'translate(0px, 0px)';
  };
  el.joyZone.addEventListener('pointerup', resetJoystick);
  el.joyZone.addEventListener('pointercancel', resetJoystick);

  // Button Bindings
  el.btnStart.addEventListener('click', startGame);
  el.btnOpenMap.addEventListener('click', (e) => {
    e.currentTarget.blur();
    toggleMapModal();
  });
  document.querySelector('.minimap-shell').addEventListener('click', () => {
    toggleMapModal();
  });
  el.btnCloseMap.addEventListener('click', () => toggleMapModal());
  el.btnCloseMall.addEventListener('click', () => toggleMallModal());

  el.btnCar.addEventListener('click', (e) => {
    e.currentTarget.blur();
    toggleVehicle();
  });
  el.btnSprint.addEventListener('click', (e) => {
    e.currentTarget.blur();
    state.sprintToggle = !state.sprintToggle;
    el.btnSprint.classList.toggle('active', state.sprintToggle);
  });
  el.btnJump.addEventListener('click', (e) => {
    e.currentTarget.blur();
    triggerJump();
  });
  el.btnWeapon.addEventListener('click', (e) => {
    e.currentTarget.blur();
    triggerPunch();
  });

  el.btnMute.addEventListener('click', (e) => {
    e.currentTarget.blur();
    sound.unlock();
    const nextMuted = !sound.muted;
    sound.setMuted(nextMuted);
    el.iconSoundOn.hidden = nextMuted;
    el.iconSoundOff.hidden = !nextMuted;
  });
  el.btnPause.addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (state.mode === 'playing') setMode('paused');
    else if (state.mode === 'paused') setMode('playing');
  });
  el.btnResume.addEventListener('click', () => setMode('playing'));
  el.btnRestart.addEventListener('click', () => {
    resetWorld();
    setMode('playing');
  });
  el.btnToTitle.addEventListener('click', () => {
    resetWorld();
    setMode('title');
  });

  // Mall Store Purchase Handlers
  document.querySelectorAll('.mall-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.dataset.item;
      const prices = { armor: 250, meal: 100, sneakers: 500, bribe: 600 };
      const cost = prices[item] || 0;
      if (state.cash < cost) {
        showToast('Not enough cash!');
        return;
      }
      state.cash -= cost;
      if (item === 'armor') state.armor = 100;
      if (item === 'meal') {
        state.hp = 100;
        state.stamina = 100;
      }
      if (item === 'sneakers') state.sprintBonus = 1.28;
      if (item === 'bribe') {
        state.wanted = 0;
        state.wantedTimer = 0;
      }
      sound.playCash();
      updateHudDom();
      showToast(`Purchased ${btn.querySelector('.mall-item-name').textContent}`);
    });
  });

  // Full City Map Click-to-Set-Waypoint
  fullmapCanvas.addEventListener('click', (e) => {
    const rect = fullmapCanvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const wx = (nx - 0.5) * 260;
    const wz = (ny - 0.5) * 260;
    state.waypoint = { x: wx, z: wz };
    drawFullMap();
    showToast('GPS Waypoint Set');
  });

  // ============================================================================
  // 9. MINIMAP & FULL CITY MAP RENDERERS
  // ============================================================================
  function drawMapSurface(ctx, w, h, centerX, centerZ, scale, showLabels) {
    ctx.fillStyle = '#1b1f26';
    ctx.fillRect(0, 0, w, h);

    const toScreen = (wx, wz) => ({
      x: w * 0.5 + (wx - centerX) * scale,
      y: h * 0.5 + (wz - centerZ) * scale,
    });

    // City Blocks
    ctx.fillStyle = '#2c323d';
    const blocks = [
      [-95, -145, 76, 70],
      [19, -145, 76, 70],
      [-95, -55, 76, 125],
      [19, -55, 76, 125],
      [-95, 90, 76, 70],
      [19, 90, 76, 70],
    ];
    blocks.forEach(([bx, bz, bw, bd]) => {
      const p = toScreen(bx, bz);
      ctx.fillRect(p.x, p.y, bw * scale, bd * scale);
    });

    // Main Boulevard & Cross Streets
    ctx.fillStyle = '#474f5e';
    const roadTop = toScreen(-WORLD.roadHalfWidth, -165);
    ctx.fillRect(roadTop.x, roadTop.y, WORLD.roadHalfWidth * 2 * scale, 330 * scale);
    [-65, 80].forEach((cz) => {
      const cr = toScreen(-120, cz - 9);
      ctx.fillRect(cr.x, cr.y, 240 * scale, 18 * scale);
    });

    // Elevated Overpass stripe
    ctx.fillStyle = '#64748b';
    const ov = toScreen(-110, -62.5);
    ctx.fillRect(ov.x, ov.y, 220 * scale, 13 * scale);

    // City Mall Landmark (Blue T-Shirt / Shop Badge)
    const mallPt = toScreen(WORLD.mallZone.x, WORLD.mallZone.z);
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(mallPt.x, mallPt.y, showLabels ? 10 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Safe House Landmark (White House Badge)
    const safePt = toScreen(WORLD.safeHouseZone.x, WORLD.safeHouseZone.z);
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.arc(safePt.x, safePt.y, showLabels ? 10 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Active Cash Pickups
    ctx.fillStyle = '#facc15';
    for (const pk of pickups) {
      if (pk.cooldown > 0) continue;
      const pp = toScreen(pk.x, pk.z);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, showLabels ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Waypoint
    if (state.waypoint) {
      const wp = toScreen(state.waypoint.x, state.waypoint.z);
      const pl = toScreen(state.player.x, state.player.z);
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(pl.x, pl.y);
      ctx.lineTo(wp.x, wp.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#c084fc';
      ctx.beginPath();
      ctx.arc(wp.x, wp.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Traffic Cars
    for (const v of vehicles) {
      const vp = toScreen(v.x, v.z);
      ctx.fillStyle = v.type === 'police' ? '#3b82f6' : '#cbd5e1';
      ctx.fillRect(vp.x - 2, vp.y - 3, 4, 6);
    }

    // Player Directional Arrow
    const plPt = toScreen(state.player.x, state.player.z);
    ctx.save();
    ctx.translate(plPt.x, plPt.y);
    ctx.rotate(-state.player.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#090b0f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (showLabels) {
      ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText('LOS SANTOS CITY MALL', mallPt.x + 14, mallPt.y + 4);
      ctx.fillText('SAFE HOUSE', safePt.x + 14, safePt.y + 4);
      const towerPt = toScreen(11, -120);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('MAZE TOWER SKYLINE', towerPt.x - 56, towerPt.y);
    }
  }

  function drawMinimap() {
    drawMapSurface(
      minimapCtx,
      minimapCanvas.width,
      minimapCanvas.height,
      state.player.x,
      state.player.z,
      1.7,
      false
    );
  }

  function drawFullMap() {
    drawMapSurface(fullmapCtx, fullmapCanvas.width, fullmapCanvas.height, 0, 0, 2.2, true);
  }

  // ============================================================================
  // 10. SIMULATION UPDATE & ANIMATION LOOP
  // ============================================================================
  const clock = new THREE.Clock();
  let frameId = 0;
  let totalTime = 0;

  // Initialize player & vehicles once for first frame
  playerMesh.position.set(state.player.x, state.player.y, state.player.z);
  playerMesh.rotation.y = state.player.yaw;

  function updateWantedStarsVisual(time) {
    const flashPhase = Math.floor(time * 5) % 2 === 0;
    el.stars.forEach((star, idx) => {
      const active = idx < state.wanted;
      star.classList.toggle('active', active);
      star.classList.toggle('flash-red', active && flashPhase);
      star.classList.toggle('flash-blue', active && !flashPhase);
    });
  }

  function updateSimulation(dt) {
    totalTime += dt;
    skyDome.material.uniforms.uTime.value = totalTime;

    // Spin landmark rings
    markerRing.rotation.z = totalTime * 1.1;
    safeRing.rotation.z = -totalTime * 1.1;

    // Helicopter Flight Patrol / Pursuit
    const heliTargetX = state.wanted > 0 ? state.player.x + Math.cos(totalTime * 0.45) * 24 : 22 + Math.sin(totalTime * 0.22) * 14;
    const heliTargetZ = state.wanted > 0 ? state.player.z + Math.sin(totalTime * 0.45) * 24 : -74 + Math.cos(totalTime * 0.18) * 16;
    helicopter.position.x = damp(helicopter.position.x, heliTargetX, 1.5, dt);
    helicopter.position.z = damp(helicopter.position.z, heliTargetZ, 1.5, dt);
    helicopter.position.y = 33 + Math.sin(totalTime * 1.3) * 1.2;
    helicopter.rotation.y = Math.atan2(-(heliTargetX - helicopter.position.x), -(heliTargetZ - helicopter.position.z)) + 0.5;
    helicopter.rotation.z = -0.08;
    const hRig = helicopter.userData.heliRig;
    hRig.mainRotor.rotation.y += dt * 24;
    hRig.tailRotor.rotation.x += dt * 32;
    hRig.strobeMat.emissiveIntensity = Math.sin(totalTime * 9) > 0.3 ? 3.5 : 0.2;
    hRig.searchlight.visible = state.wanted > 0;

    // Traffic & Driven Vehicles
    for (const v of vehicles) {
      const rig = v.mesh.userData.carRig;
      if (v.driverControlled) {
        // Player drives vehicle
        const throttle =
          (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
          (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) -
          joystick.dy;
        const steerInput =
          (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) -
          (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
          joystick.dx;
        const handbrake = keys.has('Space');

        const maxSpeed = 30;
        if (Math.abs(throttle) > 0.08) {
          v.speed = clamp(v.speed + throttle * 22 * dt, -11, maxSpeed);
        } else {
          v.speed = damp(v.speed, 0, handbrake ? 6 : 2.2, dt);
        }
        if (handbrake) v.speed = damp(v.speed, 0, 5.5, dt);

        const steerFactor = clamp(Math.abs(v.speed) / 7, 0, 1) * (v.speed >= 0 ? 1 : -1);
        v.yaw = wrapAngle(v.yaw + steerInput * 2.35 * steerFactor * dt);

        const nx = v.x - Math.sin(v.yaw) * v.speed * dt;
        const nz = v.z - Math.cos(v.yaw) * v.speed * dt;
        const res = resolvesCollisions(nx, nz, 1.35);
        if (res.hit && Math.abs(v.speed) > 6) {
          v.speed *= -0.35;
          state.trauma = Math.min(1, state.trauma + 0.35);
          sound.playBump();
        }
        v.x = res.x;
        v.z = res.z;
        state.player.x = v.x;
        state.player.z = v.z;
        state.player.y = 0;
        state.player.yaw = v.yaw;

        // Check collision with other traffic cars
        for (const other of vehicles) {
          if (other === v) continue;
          const dist = Math.hypot(other.x - v.x, other.z - v.z);
          if (dist < 2.9 && Math.abs(v.speed) > 4) {
            const pushX = (v.x - other.x) / (dist || 1);
            const pushZ = (v.z - other.z) / (dist || 1);
            v.x += pushX * 0.4;
            v.z += pushZ * 0.4;
            v.speed *= 0.4;
            addWantedStar(1);
            sound.playBump();
            state.trauma = Math.min(1, state.trauma + 0.45);
          }
        }

        rig.tailMat.emissiveIntensity = throttle < -0.1 || handbrake ? 4.5 : 2.0;
        el.speedValue.textContent = Math.round(Math.abs(v.speed) * 3.6);
        sound.updateEngine(state.mode === 'playing', v.speed / maxSpeed);
      } else if (!v.parked) {
        // AI Traffic cruising along boulevard
        const pursuit = v.type === 'police' && state.wanted > 0;
        if (pursuit) {
          const dx = state.player.x - v.x;
          const dz = state.player.z - v.z;
          const dist = Math.hypot(dx, dz);
          const targetYaw = Math.atan2(-dx, -dz);
          const diff = wrapAngle(targetYaw - v.yaw);
          v.yaw = wrapAngle(v.yaw + clamp(diff, -2.1 * dt, 2.1 * dt));
          v.speed = dist > 7 ? 17 : 0;
          const nx = v.x - Math.sin(v.yaw) * v.speed * dt;
          const nz = v.z - Math.cos(v.yaw) * v.speed * dt;
          const res = resolvesCollisions(nx, nz, 1.35);
          v.x = res.x;
          v.z = res.z;
        } else {
          // Cruise smoothly on assigned lane
          const distToPlayer = Math.hypot(state.player.x - v.x, state.player.z - v.z);
          const blockedByPlayer = distToPlayer < 5.5 && !state.player.inVehicle;
          const targetSpd = blockedByPlayer ? 0 : v.aiSpeed;
          v.speed = damp(v.speed, targetSpd, 3.2, dt);
          v.z += v.dir * v.speed * dt;
          if (v.z < -145) v.z = 140;
          if (v.z > 145) v.z = -140;
          v.x = damp(v.x, v.laneX, 2.0, dt);
          v.yaw = v.dir < 0 ? 0 : Math.PI;
        }
        rig.tailMat.emissiveIntensity = v.speed < 1 ? 3.8 : 2.0;
      }

      if (rig.lightbarRed && rig.lightbarBlue) {
        const sirenOn = state.wanted > 0 || !v.parked;
        const p = Math.sin(totalTime * 14) > 0;
        rig.lightbarRed.visible = sirenOn ? p : false;
        rig.lightbarBlue.visible = sirenOn ? !p : false;
      }

      v.mesh.position.set(v.x, 0, v.z);
      v.mesh.rotation.y = v.yaw;
      for (const w of rig.wheels) {
        w.children[0].rotation.x -= v.speed * dt * 2.2;
        w.children[1].rotation.x -= v.speed * dt * 2.2;
      }
    }

    // Pedestrians
    for (const ped of pedestrians) {
      if (ped.stunTimer > 0) {
        ped.stunTimer -= dt;
        ped.mesh.rotation.x = 0.35;
        continue;
      }
      ped.mesh.rotation.x = 0;
      ped.z += ped.dir * ped.speed * dt;
      if (ped.z > 90) ped.dir = -1;
      if (ped.z < -90) ped.dir = 1;
      ped.mesh.position.set(ped.x, WORLD.sidewalkHeight, ped.z);
      ped.mesh.rotation.y = ped.dir > 0 ? Math.PI : 0;

      ped.walkPhase += ped.speed * dt * 4.4;
      const swing = Math.sin(ped.walkPhase) * 0.45;
      const pRig = ped.mesh.userData.rig;
      pRig.leftLeg.rotation.x = swing;
      pRig.rightLeg.rotation.x = -swing;
      pRig.leftArm.rotation.x = -swing * 0.7;
      pRig.rightArm.rotation.x = swing * 0.7;
    }

    // Pickups spin & collection
    for (const pk of pickups) {
      if (pk.cooldown > 0) {
        pk.cooldown -= dt;
        pk.mesh.visible = pk.cooldown <= 0;
        continue;
      }
      pk.mesh.visible = true;
      pk.mesh.rotation.y += dt * 2.1;
      pk.mesh.position.y = pk.baseY + Math.sin(totalTime * 3 + pk.x) * 0.14;

      if (state.mode === 'playing') {
        const dist = Math.hypot(state.player.x - pk.x, state.player.z - pk.z);
        if (dist < 2.2) {
          pk.cooldown = 30;
          pk.mesh.visible = false;
          state.cash += pk.value;
          sound.playCash();
          showToast(`Collected Street Cash +$${pk.value}`);
          updateHudDom();
        }
      }
    }

    // Player On-Foot Movement (when playing and not driving)
    if (state.mode === 'playing' && !state.modalOpen && !state.player.inVehicle) {
      const moveForward =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) -
        joystick.dy;
      const moveRight =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) +
        joystick.dx;

      const mag = Math.hypot(moveForward, moveRight);
      const wantsSprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || state.sprintToggle;
      const sprinting = wantsSprint && mag > 0.1 && state.stamina > 2;

      if (sprinting) {
        state.stamina = Math.max(0, state.stamina - 18 * dt);
      } else {
        state.stamina = Math.min(100, state.stamina + 14 * dt);
      }

      const speed = (sprinting ? 8.8 : 4.6) * state.sprintBonus;

      if (mag > 0.08) {
        const nf = moveForward / Math.max(1, mag);
        const nr = moveRight / Math.max(1, mag);
        // Move relative to cameraYaw
        const camForwardX = -Math.sin(state.cameraYaw);
        const camForwardZ = -Math.cos(state.cameraYaw);
        const camRightX = Math.cos(state.cameraYaw);
        const camRightZ = -Math.sin(state.cameraYaw);

        const vx = camForwardX * nf + camRightX * nr;
        const vz = camForwardZ * nf + camRightZ * nr;
        const vLen = Math.hypot(vx, vz) || 1;
        const dx = (vx / vLen) * speed * Math.min(1, mag) * dt;
        const dz = (vz / vLen) * speed * Math.min(1, mag) * dt;

        const targetYaw = Math.atan2(-vx, -vz);
        const diff = wrapAngle(targetYaw - state.player.yaw);
        state.player.yaw = wrapAngle(state.player.yaw + diff * Math.min(1, dt * 12));

        const res = resolvesCollisions(state.player.x + dx, state.player.z + dz, 0.45);
        state.player.x = res.x;
        state.player.z = res.z;

        state.player.walkPhase += speed * dt * 2.4;
        sound.stepTimer -= dt;
        if (state.player.onGround && sound.stepTimer <= 0) {
          sound.playStep(sprinting);
          sound.stepTimer = sprinting ? 0.28 : 0.44;
        }
      } else {
        state.player.walkPhase = damp(state.player.walkPhase, Math.round(state.player.walkPhase / Math.PI) * Math.PI, 8, dt);
      }

      // Gravity & Jump
      const floorY = groundHeightAt(state.player.x, state.player.z);
      state.player.vy -= 20 * dt;
      state.player.y += state.player.vy * dt;
      if (state.player.y <= floorY) {
        state.player.y = floorY;
        state.player.vy = 0;
        state.player.onGround = true;
      }

      // Character Gait + Punch Animation
      const rig = playerMesh.userData.rig;
      const moveAmt = mag > 0.08 ? Math.min(1, mag) * (sprinting ? 1.0 : 0.72) : 0;
      const swing = Math.sin(state.player.walkPhase) * 0.65 * moveAmt;
      rig.leftLeg.rotation.x = swing;
      rig.rightLeg.rotation.x = -swing;
      rig.leftArm.rotation.x = -swing * 0.75;
      rig.rightArm.rotation.x = swing * 0.75;
      rig.bodyPivot.position.y = Math.abs(Math.sin(state.player.walkPhase)) * 0.04 * moveAmt;

      if (state.player.punchTimer > 0) {
        state.player.punchTimer -= dt;
        const pProgress = 1 - state.player.punchTimer / 0.34;
        rig.rightArm.rotation.x = Math.sin(pProgress * Math.PI) * 1.55;
      }

      playerMesh.position.set(state.player.x, state.player.y, state.player.z);
      playerMesh.rotation.y = state.player.yaw;
    }

    // Safe House & Mall Zone Checks + Wanted Decay
    if (state.mode === 'playing') {
      if (state.wanted > 0) {
        state.wantedTimer -= dt;
        if (state.wantedTimer <= 0) {
          state.wanted = Math.max(0, state.wanted - 1);
          state.wantedTimer = state.wanted > 0 ? 12 : 0;
          if (state.wanted === 0) showToast('Police heat cleared!');
        }
      }
      updateWantedStarsVisual(totalTime);

      const distSafe = Math.hypot(state.player.x - WORLD.safeHouseZone.x, state.player.z - WORLD.safeHouseZone.z);
      if (distSafe < WORLD.safeHouseZone.radius && (state.wanted > 0 || state.hp < 100)) {
        state.wanted = 0;
        state.wantedTimer = 0;
        state.hp = 100;
        showToast('Safe House: Health Restored & Wanted Cleared');
        updateHudDom();
      }

      // Contextual prompt
      const nearCar = !state.player.inVehicle ? getNearestEnterableVehicle() : null;
      const distMall = Math.hypot(state.player.x - WORLD.mallZone.x, state.player.z - WORLD.mallZone.z);
      el.btnCar.classList.toggle('highlight-car', Boolean(nearCar) || Boolean(state.player.inVehicle));

      if (state.player.inVehicle) {
        el.prompt.textContent = `Driving ${state.player.inVehicle.name} · Press F to exit`;
        el.prompt.hidden = false;
      } else if (nearCar) {
        el.prompt.textContent = `Press F to enter ${nearCar.name}`;
        el.prompt.hidden = false;
      } else if (distMall < WORLD.mallZone.radius) {
        el.prompt.textContent = 'Press E to enter Los Santos City Mall';
        el.prompt.hidden = false;
      } else {
        el.prompt.hidden = true;
      }

      // Toast countdown
      if (state.toastTimer > 0) {
        state.toastTimer -= dt;
        if (state.toastTimer <= 0) el.toast.hidden = true;
      }

      // Update Vitals bars smoothly
      el.minimapStamina.style.width = `${clamp(state.stamina, 0, 100)}%`;
      el.vitalStamina.style.width = `${clamp(state.stamina, 0, 100)}%`;
    }

    // Camera Rig (Title Scenic vs Gameplay Third-Person Follow + Wall Pull-In)
    if (state.mode === 'title') {
      const panX = Math.sin(totalTime * 0.25) * 0.45;
      _vec3A.set(14.35 + panX, 2.28, 41.4);
      _vec3B.set(7.5, 3.8, -28);
      camera.position.lerp(_vec3A, 1 - Math.exp(-3 * dt));
      camera.lookAt(_vec3B);
    } else {
      const targetDist = state.player.inVehicle ? Math.max(6.2, state.cameraDist + 1.4) : state.cameraDist;
      const anchorY = state.player.inVehicle ? 1.55 : state.player.y + 1.65;
      const anchorX = state.player.x;
      const anchorZ = state.player.z;

      const desiredX = anchorX + Math.sin(state.cameraYaw) * Math.cos(state.cameraPitch) * targetDist;
      const desiredY = anchorY + Math.sin(state.cameraPitch) * targetDist + 0.35;
      const desiredZ = anchorZ + Math.cos(state.cameraYaw) * Math.cos(state.cameraPitch) * targetDist;

      // Prevent camera going underground or inside buildings
      const safeCam = resolvesCollisions(desiredX, desiredZ, 0.55);
      _vec3A.set(safeCam.x, Math.max(0.7, desiredY), safeCam.z);

      // Subtle look-ahead toward skyline/heading
      _vec3B.set(
        anchorX - Math.sin(state.cameraYaw) * 6.5,
        anchorY + 0.65,
        anchorZ - Math.cos(state.cameraYaw) * 6.5
      );

      state.cameraCurPos.lerp(_vec3A, 1 - Math.exp(-10 * dt));
      state.cameraCurLook.lerp(_vec3B, 1 - Math.exp(-12 * dt));

      // Decaying trauma shake
      if (state.trauma > 0) {
        state.trauma = Math.max(0, state.trauma - dt * 2.2);
        const shake = state.trauma * state.trauma * 0.28;
        camera.position.set(
          state.cameraCurPos.x + (Math.random() - 0.5) * shake,
          state.cameraCurPos.y + (Math.random() - 0.5) * shake,
          state.cameraCurPos.z + (Math.random() - 0.5) * shake
        );
      } else {
        camera.position.copy(state.cameraCurPos);
      }
      camera.lookAt(state.cameraCurLook);
    }

    // Throttle minimap canvas redraw to ~12 Hz
    if (totalTime - state.lastMinimapTime > 0.08) {
      state.lastMinimapTime = totalTime;
      drawMinimap();
      if (state.modalOpen === 'map') drawFullMap();
    }
  }

  function afterDraw(cb) {
    const gl = renderer.getContext();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (status === gl.UNSIGNALED) {
        frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        frameId = window.setTimeout(cb, 80);
      }
    };
    frameId = window.setTimeout(poll, 5);
  }

  function tick() {
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    if (state.mode !== 'paused') {
      updateSimulation(dt);
    }
    renderer.render(scene, camera);
    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }
  }

  // Handle Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // WebGL context safety
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(frameId);
    clearTimeout(frameId);
  });

  // Pre-warm shaders on real GPUs
  if (!isSoftwareGl) {
    renderer.compile(scene, camera);
  }

  // Support ?autostart=1 for automated test verification
  const params = new URLSearchParams(window.location.search);
  updateHudDom();
  drawMinimap();
  if (params.get('autostart') === '1') {
    setMode('playing');
  } else {
    setMode('title');
  }

  tick();
}

initGame();
