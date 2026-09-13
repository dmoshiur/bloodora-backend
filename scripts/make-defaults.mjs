// Generate default product images (no dependencies) and register them into
// src/data/defaults.ts so the database seeds reference real stored files.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "uploads");
mkdirSync(outDir, { recursive: true });

const CATEGORIES = {
  blood_test: { bg: [198, 40, 40], label: "BLOOD TEST", icon: "beaker" },
  bandage: { bg: [230, 126, 34], label: "BANDAGE", icon: "roll" },
  gauze: { bg: [69, 90, 100], label: "GAUZE", icon: "pad" },
  vitamin: { bg: [26, 115, 232], label: "VITAMIN", icon: "bottle" },
  first_aid: { bg: [102, 187, 106], label: "FIRST AID", icon: "kit" },
  antiseptic: { bg: [38, 166, 154], label: "ANTISEPTIC", icon: "dropper" },
  thermometer: { bg: [124, 77, 255], label: "THERMOMETER", icon: "thermo" },
  oxygen: { bg: [2, 136, 209], label: "OXYGEN", icon: "cylinder" },
};

function drawIcon(ctx, icon, x, y, s, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(6, s * 0.07);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.save();
  ctx.translate(x, y);
  switch (icon) {
    case "beaker":
      ctx.beginPath();
      ctx.moveTo(-s * 0.25, -s * 0.5);
      ctx.lineTo(-s * 0.25, -s * 0.1);
      ctx.lineTo(-s * 0.45, s * 0.45);
      ctx.lineTo(s * 0.45, s * 0.45);
      ctx.lineTo(s * 0.25, -s * 0.1);
      ctx.lineTo(s * 0.25, -s * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, s * 0.12, s * 0.3, s * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "roll":
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * 0.4, s * 0.1);
      ctx.lineTo(s * 0.62, s * 0.34);
      ctx.lineTo(s * 0.4, s * 0.34);
      ctx.stroke();
      break;
    case "pad":
      ctx.strokeRect(-s * 0.42, -s * 0.42, s * 0.84, s * 0.84);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * s * 0.2, -s * 0.3);
        ctx.lineTo(i * s * 0.2, s * 0.3);
        ctx.stroke();
      }
      break;
    case "bottle":
      ctx.strokeRect(-s * 0.28, -s * 0.2, s * 0.56, s * 0.66);
      ctx.strokeRect(-s * 0.12, -s * 0.5, s * 0.24, s * 0.3);
      ctx.beginPath();
      ctx.arc(0, s * 0.1, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "kit":
      ctx.strokeRect(-s * 0.45, -s * 0.35, s * 0.9, s * 0.7);
      ctx.strokeRect(-s * 0.18, -s * 0.52, s * 0.36, s * 0.17);
      ctx.beginPath();
      ctx.moveTo(-s * 0.14, 0);
      ctx.lineTo(s * 0.14, 0);
      ctx.moveTo(0, -s * 0.14);
      ctx.lineTo(0, s * 0.14);
      ctx.stroke();
      break;
    case "dropper":
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.5);
      ctx.lineTo(0, s * 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, s * 0.2);
      ctx.lineTo(s * 0.18, s * 0.2);
      ctx.lineTo(0, s * 0.52);
      ctx.closePath();
      ctx.stroke();
      break;
    case "thermo":
      ctx.strokeRect(-s * 0.09, -s * 0.5, s * 0.18, s * 0.8);
      ctx.beginPath();
      ctx.arc(0, s * 0.44, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "cylinder":
      ctx.strokeRect(-s * 0.22, -s * 0.3, s * 0.44, s * 0.75);
      ctx.beginPath();
      ctx.arc(0, -s * 0.3, s * 0.22, Math.PI, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.52);
      ctx.lineTo(0, -s * 0.62);
      ctx.lineTo(s * 0.1, -s * 0.62);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function makeImage(category, name) {
  const spec = CATEGORIES[category] || CATEGORIES.bandage;
  const W = 640, H = 480;
  const [r, g, b] = spec.bg;
  const lines = [];
  // PNG: signature + IHDR + IDAT (zlib deflate of raw scanlines) + IEND
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      // subtle diagonal gradient
      const t = (x + y) / (W + H);
      const p = rowStart + 1 + x * 4;
      raw[p] = Math.round(r * (0.82 + 0.18 * t));
      raw[p + 1] = Math.round(g * (0.82 + 0.18 * t));
      raw[p + 2] = Math.round(b * (0.82 + 0.18 * t));
      raw[p + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const chunks = [];
  const push = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = crc32(Buffer.concat([typeBuf, data]));
    chunks.push(len, typeBuf, data, Buffer.from([crc >>> 24 & 255, crc >>> 16 & 255, crc >>> 8 & 255, crc & 255]));
  };
  push("IHDR", ihdr);
  push("IDAT", idat);
  push("IEND", Buffer.alloc(0));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
  return png;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const products = [
  ["bp-101", "blood_pressure_monitor", "Blood Pressure Monitor", "blood_test", 3200],
  ["hem-201", "hemoglobin_meter", "Hemoglobin Meter", "blood_test", 4500],
  ["sugar-301", "glucometer", "Blood Glucose Meter", "blood_test", 1800],
  ["band-401", "elastic_bandage", "Elastic Bandage", "bandage", 350],
  ["band-402", "adhesive_bandage_pack", "Adhesive Bandage Pack", "bandage", 150],
  ["gauze-501", "sterile_gauze", "Sterile Gauze Pads", "gauze", 220],
  ["vit-601", "vitamin_c_1000", "Vitamin C 1000mg", "vitamin", 550],
  ["vit-602", "iron_supplement", "Iron Supplement", "vitamin", 780],
  ["aid-701", "first_aid_kit", "First Aid Kit", "first_aid", 1250],
  ["ant-801", "antiseptic_liquid", "Antiseptic Liquid 250ml", "antiseptic", 420],
  ["ant-802", "iodine_solution", "Iodine Solution", "antiseptic", 320],
  ["therm-901", "digital_thermometer", "Digital Thermometer", "thermometer", 450],
  ["oxy-1001", "oxygen_cylinder_small", "Portable Oxygen Cylinder", "oxygen", 8500],
  ["oxy-1002", "oxygen_mask", "Oxygen Mask Set", "oxygen", 650],
];

// main
const defs = [];
for (const [id, slug, name, category, price] of products) {
  const png = makeImage(category, name);
  const filename = `default_${slug}.png`;
  writeFileSync(path.join(outDir, filename), png);
  defs.push({ filename, url: `/uploads/${filename}`, id, category });
}
const ts = `// GENERATED by scripts/make-defaults.mjs — do not edit by hand.\n
export interface DefaultImage {
  filename: string;
  url: string;
  id: string;
  category: string;
}

export const DEFAULT_IMAGES: DefaultImage[] = ${JSON.stringify(defs, null, 2)};

export function defaultImageForId(id: string): string | null {
  const d = DEFAULT_IMAGES.find((x) => x.id === id);
  return d ? d.url : null;
}

export function defaultImageForCategory(category: string | null): string | null {
  const d = DEFAULT_IMAGES.find((x) => x.category === category);
  return d ? d.url : null;
}\n`;
writeFileSync(path.join(root, "src", "data", "defaults.ts"), ts);
console.log(`Wrote ${defs.length} default images to uploads/ and src/data/defaults.ts`);
