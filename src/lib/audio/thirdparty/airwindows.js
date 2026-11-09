// Two Airwindows processors ported to JavaScript from
// https://github.com/airwindows/airwindows (MIT License, Copyright (c) 2018
// Chris Johnson; full notice in THIRD_PARTY_NOTICES.md):
//   ClipOnly2 — a clipper that suppresses the brightness of digital clipping
//               without touching unclipped samples (any sample rate).
//   ToTape6   — Airwindows tape emulation: flutter, head bump, soft highs,
//               saturation and ADClip, all in one.
// Ported from the LinuxVST processReplacing loops; the 32-bit float dither at
// the end of each loop is left out (the app dithers once, at export).

// One channel in, one out. Latency: floor(sr / 44100) samples.
export function clipOnly2Channel(x, sr = 44100) {
  let spacing = Math.floor(sr / 44100);
  if (spacing < 1) spacing = 1;
  if (spacing > 16) spacing = 16;
  const inter = new Float64Array(17);
  const out = new Float32Array(x.length);
  let last = 0;
  let wasPos = false;
  let wasNeg = false;
  for (let n = 0; n < x.length; n++) {
    let s = x[n];
    if (s > 4) s = 4;
    if (s < -4) s = -4;
    if (wasPos) {
      if (s < last) last = 0.7058208 + s * 0.2609148;
      else last = 0.2491717 + last * 0.7390851;
    }
    wasPos = false;
    if (s > 0.9549925859) {
      wasPos = true;
      s = 0.7058208 + last * 0.2609148;
    }
    if (wasNeg) {
      if (s > last) last = -0.7058208 + s * 0.2609148;
      else last = -0.2491717 + last * 0.7390851;
    }
    wasNeg = false;
    if (s < -0.9549925859) {
      wasNeg = true;
      s = -0.7058208 + last * 0.2609148;
    }
    inter[spacing] = s;
    out[n] = last;
    for (let k = spacing; k > 0; k--) inter[k - 1] = inter[k];
    last = inter[0];
  }
  return out;
}

// Same as clipOnly2Channel with the latency removed, so it can sit in an
// offline chain without shifting the audio.
export function clipOnly2Aligned(x, sr) {
  const lat = Math.max(1, Math.min(16, Math.floor(sr / 44100)));
  const padded = new Float32Array(x.length + lat);
  padded.set(x);
  return clipOnly2Channel(padded, sr).slice(lat);
}

// ToTape6 with its six knobs (0..1, 0.5 = the plugin's defaults; dryWet 1).
export function toTape6(channels, sr, { input = 0.5, soften = 0.5, headBump = 0.5, flutter = 0.5, output = 0.5, dryWet = 1 } = {}) {
  const overallscale = sr / 44100;
  const inputgain = 10 ** (((input - 0.5) * 24) / 20);
  const SoftenControl = soften ** 2;
  const RollAmount = (1 - SoftenControl * 0.45) / overallscale;
  const HeadBumpControl = headBump * 0.25 * inputgain;
  const HeadBumpFreq = 0.12 / overallscale;
  const bp = (freq, q) => {
    const K = Math.tan(Math.PI * freq);
    const norm = 1 / (1 + K / q + K * K);
    const b0 = (K / q) * norm;
    return { b0, b2: -b0, a1: 2 * (K * K - 1) * norm, a2: (1 - K / q + K * K) * norm };
  };
  const bump = bp(0.007 / overallscale, 0.0009);
  const sinBp = bp(0.032 / overallscale, 0.0007);
  const depth = flutter ** 2 * overallscale * 70;
  const fluttertrim = (0.0024 * flutter ** 2) / overallscale;
  const outputgain = 10 ** (((output - 0.5) * 24) / 20);
  const refclip = 0.99;
  const softness = 0.618033988749894848204586;

  const n = channels[0].length;
  const [inL, inR] = channels.length > 1 ? channels : [channels[0], channels[0]];
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const dL = new Float64Array(501);
  const dR = new Float64Array(501);
  // interleaved biquad states [z1, z2] for A/B (head bump) and C/D (main), per side
  const st = () => ({ z1: 0, z2: 0 });
  const bq = { AL: st(), BL: st(), CL: st(), DL: st(), AR: st(), BR: st(), CR: st(), DR: st() };
  const run = (s, c, x) => {
    const y = x * c.b0 + s.z1;
    s.z1 = -y * c.a1 + s.z2; // b1 = 0
    s.z2 = x * c.b2 - y * c.a2;
    return y;
  };
  const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);
  let iirMidRollerAL = 0, iirMidRollerBL = 0, iirHeadBumpAL = 0, iirHeadBumpBL = 0;
  let iirMidRollerAR = 0, iirMidRollerBR = 0, iirHeadBumpAR = 0, iirHeadBumpBR = 0;
  let flip = false, gcount = 0, rateof = 0.5, sweep = Math.PI, nextmax = 0.5, lastL = 0, lastR = 0;
  let fpd = 17; // xorshift state, only for the flutter randomness
  const adclip = (s, last) => {
    if (last >= refclip) last = s < refclip ? refclip * softness + s * (1 - softness) : refclip;
    if (last <= -refclip) last = s > -refclip ? -refclip * softness + s * (1 - softness) : -refclip;
    if (s > refclip) s = last < refclip ? refclip * softness + last * (1 - softness) : refclip;
    if (s < -refclip) s = last > -refclip ? -refclip * softness + last * (1 - softness) : -refclip;
    return s;
  };

  for (let i = 0; i < n; i++) {
    let L = inL[i];
    let R = inR[i];
    const dryL = L, dryR = R;
    if (inputgain < 1) { L *= inputgain; R *= inputgain; }
    const flutterrandy = fpd / 4294967295;
    if (gcount < 0 || gcount > 499) gcount = 499;
    dL[gcount] = L;
    dR[gcount] = R;
    let count = gcount;
    if (depth !== 0) {
      const offset = depth + depth * rateof ** 2 * Math.sin(sweep);
      const fl = Math.floor(offset), fr = offset - fl;
      count += fl;
      const i0 = count - (count > 499 ? 500 : 0);
      const i1 = count + 1 - (count + 1 > 499 ? 500 : 0);
      L = dL[i0] * (1 - fr) + dL[i1] * fr;
      R = dR[i0] * (1 - fr) + dR[i1] * fr;
      rateof = rateof * (1 - fluttertrim) + nextmax * fluttertrim;
      sweep += rateof * fluttertrim;
      if (sweep >= Math.PI * 2) {
        sweep -= Math.PI;
        nextmax = 0.24 + flutterrandy * 0.74;
      }
    }
    gcount--;
    const vibL = L, vibR = R;
    let HighsL, HighsR;
    if (flip) {
      iirMidRollerAL = iirMidRollerAL * (1 - RollAmount) + L * RollAmount;
      iirMidRollerAR = iirMidRollerAR * (1 - RollAmount) + R * RollAmount;
      HighsL = L - iirMidRollerAL;
      HighsR = R - iirMidRollerAR;
      iirHeadBumpAL += L * 0.05;
      iirHeadBumpAR += R * 0.05;
      iirHeadBumpAL -= iirHeadBumpAL ** 3 * HeadBumpFreq;
      iirHeadBumpAR -= iirHeadBumpAR ** 3 * HeadBumpFreq;
      iirHeadBumpAL = Math.asin(clamp1(run(bq.AL, bump, Math.sin(iirHeadBumpAL))));
      iirHeadBumpAR = Math.asin(clamp1(run(bq.AR, bump, Math.sin(iirHeadBumpAR))));
      L = Math.asin(clamp1(run(bq.CL, sinBp, Math.sin(L))));
      R = Math.asin(clamp1(run(bq.CR, sinBp, Math.sin(R))));
    } else {
      iirMidRollerBL = iirMidRollerBL * (1 - RollAmount) + L * RollAmount;
      iirMidRollerBR = iirMidRollerBR * (1 - RollAmount) + R * RollAmount;
      HighsL = L - iirMidRollerBL;
      HighsR = R - iirMidRollerBR;
      iirHeadBumpBL += L * 0.05;
      iirHeadBumpBR += R * 0.05;
      iirHeadBumpBL -= iirHeadBumpBL ** 3 * HeadBumpFreq;
      iirHeadBumpBR -= iirHeadBumpBR ** 3 * HeadBumpFreq;
      iirHeadBumpBL = Math.asin(clamp1(run(bq.BL, bump, Math.sin(iirHeadBumpBL))));
      iirHeadBumpBR = Math.asin(clamp1(run(bq.BR, bump, Math.sin(iirHeadBumpBR))));
      L = Math.asin(clamp1(run(bq.DL, sinBp, Math.sin(L))));
      R = Math.asin(clamp1(run(bq.DR, sinBp, Math.sin(R))));
    }
    flip = !flip;
    const groundL = vibL - L, groundR = vibR - R; // "UnBox"
    if (inputgain > 1) { L *= inputgain; R *= inputgain; }
    let soft = Math.min(Math.abs(HighsL) * 1.57079633, 1.57079633);
    soft = 1 - Math.cos(soft);
    if (HighsL > 0) L -= soft;
    if (HighsL < 0) L += soft;
    soft = Math.min(Math.abs(HighsR) * 1.57079633, 1.57079633);
    soft = 1 - Math.cos(soft);
    if (HighsR > 0) R -= soft;
    if (HighsR < 0) R += soft;
    let sup = (1 - Math.abs(L)) * 0.00013;
    if (iirHeadBumpAL > sup) iirHeadBumpAL -= sup;
    if (iirHeadBumpAL < -sup) iirHeadBumpAL += sup;
    if (iirHeadBumpBL > sup) iirHeadBumpBL -= sup;
    if (iirHeadBumpBL < -sup) iirHeadBumpBL += sup;
    sup = (1 - Math.abs(R)) * 0.00013;
    if (iirHeadBumpAR > sup) iirHeadBumpAR -= sup;
    if (iirHeadBumpAR < -sup) iirHeadBumpAR += sup;
    if (iirHeadBumpBR > sup) iirHeadBumpBR -= sup;
    if (iirHeadBumpBR < -sup) iirHeadBumpBR += sup;
    L += (iirHeadBumpAL + iirHeadBumpBL) * HeadBumpControl;
    R += (iirHeadBumpAR + iirHeadBumpBR) * HeadBumpControl;
    L = clamp1(L);
    R = clamp1(R);
    let mojo = Math.abs(L) ** 0.25;
    if (mojo > 0) L = Math.sin(L * mojo * Math.PI * 0.5) / mojo;
    mojo = Math.abs(R) ** 0.25;
    if (mojo > 0) R = Math.sin(R * mojo * Math.PI * 0.5) / mojo;
    L += groundL;
    R += groundR;
    if (outputgain !== 1) { L *= outputgain; R *= outputgain; }
    L = adclip(L, lastL);
    lastL = L;
    R = adclip(R, lastR);
    lastR = R;
    L = Math.max(-refclip, Math.min(refclip, L));
    R = Math.max(-refclip, Math.min(refclip, R));
    if (dryWet !== 1) {
      L = L * dryWet + dryL * (1 - dryWet);
      R = R * dryWet + dryR * (1 - dryWet);
    }
    fpd ^= fpd << 13; fpd >>>= 0;
    fpd ^= fpd >>> 17;
    fpd ^= fpd << 5; fpd >>>= 0;
    outL[i] = L;
    outR[i] = R;
  }
  return [outL, outR];
}
