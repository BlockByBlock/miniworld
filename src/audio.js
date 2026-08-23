// WebAudio presentation layer: a tiny synth for game sound effects.
// Recipes live in SFX_RECIPES (data, not branches); the rest of the app only
// ever calls initAudio() and playSfx(name).

let audioContext = null;
let noiseBuffer = null;

export function initAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
    noiseBuffer = audioContext.createBuffer(1, Math.floor(audioContext.sampleRate * 0.35), audioContext.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  }
  if (audioContext.state === 'suspended') audioContext.resume();
}

function playTone({ frequency = 220, endFrequency = frequency, duration = 0.12, gain = 0.035, type = 'sine' } = {}) {
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
  volume.gain.setValueAtTime(gain, now);
  volume.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(volume).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function playNoise({ duration = 0.08, gain = 0.025, frequency = 900 } = {}) {
  if (!audioContext || audioContext.state !== 'running' || !noiseBuffer) return;
  const now = audioContext.currentTime;
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const volume = audioContext.createGain();
  source.buffer = noiseBuffer;
  filter.type = 'lowpass';
  filter.frequency.value = frequency;
  volume.gain.setValueAtTime(gain, now);
  volume.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter).connect(volume).connect(audioContext.destination);
  source.start(now);
  source.stop(now + duration);
}

// Synth recipes per effect name: each entry is a list of playNoise/playTone
// parameter sets, played in order. Adding a sound is data, not a branch.
const SFX_RECIPES = {
  sword: [
    { noise: { duration: 0.09, gain: 0.035, frequency: 1800 } },
    { tone: { frequency: 210, endFrequency: 105, duration: 0.1, gain: 0.018, type: 'triangle' } },
  ],
  fire: [
    { noise: { duration: 0.2, gain: 0.025, frequency: 1400 } },
    { tone: { frequency: 180, endFrequency: 420, duration: 0.18, gain: 0.026, type: 'sawtooth' } },
  ],
  'cast-fire': [{ tone: { frequency: 180, endFrequency: 520, duration: 0.24, gain: 0.018, type: 'sawtooth' } }],
  'fire-launch': [{ noise: { duration: 0.08, gain: 0.018, frequency: 1800 } }],
  'fire-impact': [
    { noise: { duration: 0.16, gain: 0.03, frequency: 1200 } },
    { tone: { frequency: 260, endFrequency: 90, duration: 0.18, gain: 0.022, type: 'triangle' } },
  ],
  freeze: [
    { tone: { frequency: 740, endFrequency: 290, duration: 0.28, gain: 0.026, type: 'sine' } },
    { tone: { frequency: 980, endFrequency: 520, duration: 0.2, gain: 0.014, type: 'triangle' } },
  ],
  'cast-freeze': [{ tone: { frequency: 420, endFrequency: 980, duration: 0.3, gain: 0.018, type: 'sine' } }],
  'frost-launch': [{ tone: { frequency: 960, endFrequency: 620, duration: 0.12, gain: 0.014, type: 'triangle' } }],
  'frost-impact': [
    { tone: { frequency: 1080, endFrequency: 260, duration: 0.24, gain: 0.022, type: 'sine' } },
    { noise: { duration: 0.1, gain: 0.018, frequency: 2400 } },
  ],
  'cast-heal': [{ tone: { frequency: 260, endFrequency: 640, duration: 0.32, gain: 0.018, type: 'sine' } }],
  'heal-impact': [{ tone: { frequency: 520, endFrequency: 860, duration: 0.24, gain: 0.02, type: 'sine' } }],
  'cast-buff': [{ tone: { frequency: 220, endFrequency: 740, duration: 0.28, gain: 0.018, type: 'triangle' } }],
  'ward-impact': [{ tone: { frequency: 360, endFrequency: 180, duration: 0.24, gain: 0.022, type: 'triangle' } }],
  hurt: [
    { noise: { duration: 0.13, gain: 0.045, frequency: 520 } },
    { tone: { frequency: 120, endFrequency: 70, duration: 0.16, gain: 0.03, type: 'square' } },
  ],
  pickup: [{ tone: { frequency: 410, endFrequency: 760, duration: 0.16, gain: 0.026, type: 'sine' } }],
  equip: [{ tone: { frequency: 270, endFrequency: 430, duration: 0.14, gain: 0.025, type: 'triangle' } }],
  room: [{ tone: { frequency: 130, endFrequency: 190, duration: 0.3, gain: 0.012, type: 'sine' } }],
  step: [{ noise: { duration: 0.045, gain: 0.012, frequency: 260 } }],
  chest: [{ tone: { frequency: 330, endFrequency: 660, duration: 0.22, gain: 0.027, type: 'triangle' } }],
  'warden-phase': [
    { noise: { duration: 0.28, gain: 0.035, frequency: 420 } },
    { tone: { frequency: 92, endFrequency: 38, duration: 0.5, gain: 0.032, type: 'sawtooth' } },
    { tone: { frequency: 180, endFrequency: 72, duration: 0.36, gain: 0.022, type: 'triangle' } },
  ],
  'warden-collapse': [
    { noise: { duration: 0.12, gain: 0.026, frequency: 680 } },
    { tone: { frequency: 120, endFrequency: 420, duration: 0.34, gain: 0.022, type: 'square' } },
  ],
};

export function playSfx(name) {
  if (!audioContext || audioContext.state !== 'running') return;
  for (const recipe of SFX_RECIPES[name] ?? []) {
    if (recipe.noise) playNoise(recipe.noise);
    if (recipe.tone) playTone(recipe.tone);
  }
}
