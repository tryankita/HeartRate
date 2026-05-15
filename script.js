const video = document.getElementById('video');
const canvas = document.getElementById('offscreenCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const waveformCanvas = document.getElementById('waveformCanvas');
let wCtx;
const els = {};
['app', 'idleState', 'measuringState', 'completeState', 'startBtn', 'cancelBtn', 'restartBtn',
    'statusDot', 'statusText', 'timerDisplay', 'heartBeat', 'pulseRing1', 'pulseRing2',
    'bpmNumber', 'bpmLabel', 'signalQuality', 'qualityText', 'progressFill', 'progressPct',
    'progressHint', 'finalBpm', 'finalDuration', 'finalRange', 'confidenceBadge',
    'confidenceText', 'confidenceIcon', 'ambientGlow'].forEach(id => {
        els[id] = document.getElementById(id);
    });
const qBars = [1, 2, 3, 4, 5].map(i => document.getElementById('qb' + i));

let state = 'idle';
let track = null, animationId = null;
let measureStart = 0, lastFrameTime = 0, accTime = 0;
const MEASURE_DURATION = 60000;
const SAMPLE_RATE = 30;
const MAX_SAMPLES = 512;
const FFT_SIZE = 256;
const STABILIZATION_TIME = 25000;

let rawRed = [], rawTimestamps = [];
let filteredSignal = [];
let bpmHistory = [], allBpmReadings = [];
let fingerOffCount = 0;
let lastBeatTime = 0;
let signalConfidence = 0;
let isStabilized = false;

const HP_B = [0.8371, -1.6742, 0.8371];
const HP_A = [1.0, -1.6475, 0.7009];
const LP_B = [0.1367, 0.2734, 0.1367];
const LP_A = [1.0, -0.5861, 0.1329];
let hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
let lpState = { x1: 0, x2: 0, y1: 0, y2: 0 };

function biquadFilter(x, b, a, s) {
    const y = b[0] * x + b[1] * s.x1 + b[2] * s.x2 - a[1] * s.y1 - a[2] * s.y2;
    s.x2 = s.x1; s.x1 = x;
    s.y2 = s.y1; s.y1 = y;
    return y;
}

function bandpassFilter(x) {
    const hp = biquadFilter(x, HP_B, HP_A, hpState);
    return biquadFilter(hp, LP_B, LP_A, lpState);
}

function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = -2 * Math.PI / len;
        const wRe = Math.cos(angle), wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let j = 0; j < half; j++) {
                const tRe = curRe * re[i + j + half] - curIm * im[i + j + half];
                const tIm = curRe * im[i + j + half] + curIm * re[i + j + half];
                re[i + j + half] = re[i + j] - tRe;
                im[i + j + half] = im[i + j] - tIm;
                re[i + j] += tRe;
                im[i + j] += tIm;
                const newCurRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = newCurRe;
            }
        }
    }
}

function hannWindow(signal) {
    const n = signal.length;
    return signal.map((v, i) => v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))));
}

function estimateBpmFFT(signal) {
    if (signal.length < FFT_SIZE) return null;
    const chunk = signal.slice(-FFT_SIZE);
    const windowed = hannWindow(chunk);
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = windowed[i]; im[i] = 0; }
    fft(re, im);

    const freqRes = SAMPLE_RATE / FFT_SIZE;
    const minBin = Math.ceil(0.8 / freqRes);
    const maxBin = Math.floor(3.0 / freqRes);

    let peakMag = -1, peakBin = minBin;
    for (let i = minBin; i <= maxBin; i++) {
        const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        if (mag > peakMag) { peakMag = mag; peakBin = i; }
    }

    let interpBin = peakBin;
    if (peakBin > minBin && peakBin < maxBin) {
        const magL = Math.sqrt(re[peakBin - 1] ** 2 + im[peakBin - 1] ** 2);
        const magR = Math.sqrt(re[peakBin + 1] ** 2 + im[peakBin + 1] ** 2);
        const denom = 2 * (2 * peakMag - magL - magR);
        if (Math.abs(denom) > 1e-10) interpBin = peakBin + (magL - magR) / denom;
    }

    const peakFreq = interpBin * freqRes;
    const bpm = Math.round(peakFreq * 60);

    let totalMag = 0, count = 0;
    for (let i = minBin; i <= maxBin; i++) {
        totalMag += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        count++;
    }
    const avgMag = totalMag / count;
    const snr = avgMag > 0 ? peakMag / avgMag : 0;

    return (bpm >= 40 && bpm <= 200) ? { bpm, snr } : null;
}

function estimateBpmPeaks(signal, timestamps) {
    if (signal.length < 60) return null;
    const recent = signal.slice(-180);
    const recentTs = timestamps.slice(-180);

    const sorted = [...recent].sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.55)];

    const peaks = [];
    const minGapMs = 330;
    let lastPkTime = 0;

    for (let i = 1; i < recent.length - 1; i++) {
        if (recent[i] > recent[i - 1] && recent[i] > recent[i + 1] && recent[i] > threshold) {
            const t = recentTs[i];
            if (t - lastPkTime > minGapMs) {
                peaks.push(t);
                lastPkTime = t;
            }
        }
    }

    if (peaks.length < 3) return null;

    let ibis = [];
    for (let i = 1; i < peaks.length; i++) ibis.push(peaks[i] - peaks[i - 1]);

    const medianIBI = ibis.slice().sort((a, b) => a - b)[Math.floor(ibis.length / 2)];
    const deviations = ibis.map(v => Math.abs(v - medianIBI));
    const mad = deviations.slice().sort((a, b) => a - b)[Math.floor(deviations.length / 2)];
    const madThresh = Math.max(mad * 2.5, 40);
    ibis = ibis.filter(v => Math.abs(v - medianIBI) < madThresh);

    if (ibis.length < 2) return null;

    const avgIBI = ibis.reduce((a, b) => a + b) / ibis.length;
    const bpm = Math.round(60000 / avgIBI);
    if (peaks.length > 0) {
        const latestPeak = peaks[peaks.length - 1];
        if (latestPeak > lastBeatTime) {
            lastBeatTime = latestPeak;
            triggerBeat();
        }
    }

    return (bpm >= 40 && bpm <= 200) ? bpm : null;
}

function computeBPM() {
    if (filteredSignal.length < 90) return;

    const fftResult = estimateBpmFFT(filteredSignal);
    const peakBpm = estimateBpmPeaks(filteredSignal, rawTimestamps.slice(-filteredSignal.length));

    let finalBpm = null;
    let conf = 0;

    if (fftResult && peakBpm) {
        const diff = Math.abs(fftResult.bpm - peakBpm);
        if (diff <= 8) {
            finalBpm = Math.round((fftResult.bpm + peakBpm) / 2);
            conf = Math.min(1, fftResult.snr / 5) * (1 - diff / 20);
        } else {
            finalBpm = fftResult.bpm;
            conf = Math.min(0.6, fftResult.snr / 8);
        }
    } else if (fftResult) {
        finalBpm = fftResult.bpm;
        conf = Math.min(0.7, fftResult.snr / 6);
    } else if (peakBpm) {
        finalBpm = peakBpm;
        conf = 0.4;
    }

    if (finalBpm === null) return;

    bpmHistory.push(finalBpm);
    if (bpmHistory.length > 7) bpmHistory.shift();
    allBpmReadings.push(finalBpm);

    const sorted = [...bpmHistory].sort((a, b) => a - b);
    const medianBpm = sorted[Math.floor(sorted.length / 2)];

    const alpha = 0.08;
    const currentDisplay = parseInt(els.bpmNumber.textContent) || medianBpm;
    const smoothed = Math.round(alpha * medianBpm + (1 - alpha) * currentDisplay);

    signalConfidence = conf;

    if (bpmHistory.length >= 3 && isStabilized) {
        els.bpmNumber.textContent = smoothed;
    }
}

function detectFinger(frame) {
    const d = frame.data;
    const cx = Math.floor(frame.width / 2), cy = Math.floor(frame.height / 2);
    const region = Math.floor(Math.min(frame.width, frame.height) * 0.3);
    let rSum = 0, gSum = 0, rSqSum = 0, count = 0;

    for (let y = cy - region; y < cy + region; y += 2) {
        for (let x = cx - region; x < cx + region; x += 2) {
            const idx = (y * frame.width + x) * 4;
            if (idx >= 0 && idx < d.length) {
                const r = d[idx];
                rSum += r; gSum += d[idx + 1]; rSqSum += r * r; count++;
            }
        }
    }

    if (count === 0) return { fingerOn: false, redAvg: 0 };
    const redAvg = rSum / count;
    const greenAvg = gSum / count;
    const variance = (rSqSum / count) - (redAvg * redAvg);
    const fingerOn = redAvg > 90 && redAvg > greenAvg * 1.15 && variance < 2000;
    return { fingerOn, redAvg };
}

function triggerBeat() {
    els.heartBeat.classList.add('beat');
    setTimeout(() => els.heartBeat.classList.remove('beat'), 150);
    [els.pulseRing1, els.pulseRing2].forEach((ring, i) => {
        setTimeout(() => {
            ring.classList.remove('animate');
            void ring.offsetWidth;
            ring.classList.add('animate');
        }, i * 100);
    });
}

function updateQuality(level) {
    qBars.forEach((bar, i) => {
        bar.classList.toggle('active', i < level);
        bar.classList.toggle('poor', level <= 1);
        bar.classList.toggle('warn', level === 2 || level === 3);
    });
    const labels = ['No Signal', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'];
    els.qualityText.textContent = labels[Math.min(level, 5)];
}

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setupWaveformCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;
    wCtx = waveformCanvas.getContext('2d');
    wCtx.scale(dpr, dpr);
}

function drawWaveform(flat) {
    if (!wCtx) return;
    const w = waveformCanvas.getBoundingClientRect().width;
    const h = waveformCanvas.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    wCtx.clearRect(0, 0, w * dpr, h * dpr);

    if (flat || filteredSignal.length < 30) {
        wCtx.beginPath();
        wCtx.strokeStyle = 'rgba(255,107,107,0.2)';
        wCtx.lineWidth = 1.5;
        wCtx.moveTo(0, h / 2);
        wCtx.lineTo(w, h / 2);
        wCtx.stroke();
        return;
    }

    const display = filteredSignal.slice(-150);
    const min = Math.min(...display);
    const max = Math.max(...display);
    const range = (max - min) || 1;

    const gradient = wCtx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(255,107,107,0.25)');
    gradient.addColorStop(1, 'rgba(255,107,107,0)');

    wCtx.beginPath();
    for (let i = 0; i < display.length; i++) {
        const x = (i / (display.length - 1)) * w;
        const y = h - ((display[i] - min) / range) * h * 0.75 - h * 0.12;
        if (i === 0) wCtx.moveTo(x, y);
        else wCtx.lineTo(x, y);
    }
    wCtx.lineTo(w, h);
    wCtx.lineTo(0, h);
    wCtx.closePath();
    wCtx.fillStyle = gradient;
    wCtx.fill();

    wCtx.beginPath();
    for (let i = 0; i < display.length; i++) {
        const x = (i / (display.length - 1)) * w;
        const y = h - ((display[i] - min) / range) * h * 0.75 - h * 0.12;
        if (i === 0) wCtx.moveTo(x, y);
        else wCtx.lineTo(x, y);
    }
    wCtx.strokeStyle = '#ff6b6b';
    wCtx.lineWidth = 2;
    wCtx.lineJoin = 'round';
    wCtx.lineCap = 'round';
    wCtx.stroke();
}

function processFrame() {
    if (state !== 'measuring') return;

    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { fingerOn, redAvg } = detectFinger(frame);

    if (fingerOn) {
        fingerOffCount = 0;
    } else {
        fingerOffCount++;
    }

    const isFingerOn = fingerOffCount < 12;

    const d = frame.data;
    const cx = Math.floor(frame.width / 2), cy = Math.floor(frame.height / 2);
    const reg = Math.floor(Math.min(frame.width, frame.height) * 0.25);
    let rTotal = 0, cnt = 0;
    for (let y = cy - reg; y < cy + reg; y++) {
        for (let x = cx - reg; x < cx + reg; x++) {
            const idx = (y * frame.width + x) * 4;
            if (idx >= 0 && idx < d.length) { rTotal += d[idx]; cnt++; }
        }
    }
    const redSignal = cnt > 0 ? rTotal / cnt : 0;

    rawRed.push(redSignal);
    rawTimestamps.push(now);
    if (rawRed.length > MAX_SAMPLES) { rawRed.shift(); rawTimestamps.shift(); }

    const filtered = bandpassFilter(redSignal);
    filteredSignal.push(filtered);
    if (filteredSignal.length > MAX_SAMPLES) filteredSignal.shift();

    if (isFingerOn) {
        els.app.classList.add('finger-detected');
        video.classList.add('visible');
        accTime += dt;

        if (accTime < STABILIZATION_TIME) {
            isStabilized = false;
            const remainSec = Math.ceil((STABILIZATION_TIME - accTime) / 1000);
            els.statusDot.className = 'detecting';
            els.statusText.textContent = `Stabilizing... ${remainSec}s`;
            els.bpmNumber.textContent = '--';
        } else if (!isStabilized) {
            isStabilized = true;
            bpmHistory = [];
            allBpmReadings = [];
            els.progressHint.textContent = 'Keep holding steady';
        }

        if (isStabilized) {
            if (filteredSignal.length > 60) {
                els.statusDot.className = 'locked';
                els.statusText.textContent = 'Measuring pulse...';
            } else {
                els.statusDot.className = 'detecting';
                els.statusText.textContent = 'Detecting signal...';
            }
        }

        computeBPM();
        drawWaveform(false);

        const qualLevel = isStabilized ?
            (signalConfidence > 0.7 ? 5 : signalConfidence > 0.5 ? 4 :
            signalConfidence > 0.3 ? 3 : signalConfidence > 0.1 ? 2 : filteredSignal.length > 30 ? 1 : 0) : 0;
        updateQuality(qualLevel);

        const pct = Math.min(100, Math.floor(accTime / MEASURE_DURATION * 100));
        els.progressFill.style.width = pct + '%';
        els.progressPct.textContent = pct + '%';
        els.timerDisplay.textContent = formatTime(accTime);

        if (pct >= 100) { finishMeasurement(); return; }
    } else {
        els.app.classList.remove('finger-detected');
        video.classList.remove('visible');
        els.statusDot.className = '';
        els.statusText.textContent = 'Place finger on camera';
        updateQuality(0);
        drawWaveform(true);
    }

    animationId = requestAnimationFrame(processFrame);
}

async function startMeasurement() {
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Camera API not available. Use HTTPS.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 120 }, height: { ideal: 120 } }
        });
        video.srcObject = stream;
        track = stream.getVideoTracks()[0];

        try {
            const caps = track.getCapabilities();
            if (caps.torch) await track.applyConstraints({ advanced: [{ torch: true }] });
        } catch (e) { console.warn('Torch unavailable', e); }

        video.play();

        rawRed = []; rawTimestamps = []; filteredSignal = [];
        bpmHistory = []; allBpmReadings = [];
        hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
        lpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
        fingerOffCount = 0; lastBeatTime = 0; signalConfidence = 0;
        accTime = 0; isStabilized = false;

        els.bpmNumber.textContent = '--';
        els.progressFill.style.width = '0%';
        els.progressPct.textContent = '0%';
        els.timerDisplay.textContent = '0:00';

        setupWaveformCanvas();
        setState('measuring');

        setTimeout(() => {
            lastFrameTime = performance.now();
            measureStart = performance.now();
            processFrame();
        }, 800);

    } catch (err) {
        console.error(err);
        alert(err.message.includes('Camera') ? err.message : 'Please grant camera permissions.');
    }
}

function stopCamera() {
    if (animationId) cancelAnimationFrame(animationId);
    if (track) track.stop();
    video.srcObject = null;
    video.classList.remove('visible');
    els.app.classList.remove('finger-detected');
}

function cancelMeasurement() {
    stopCamera();
    setState('idle');
}

function finishMeasurement() {
    stopCamera();

    const finalVal = parseInt(els.bpmNumber.textContent) || 0;
    els.finalBpm.textContent = finalVal || '--';
    els.finalDuration.textContent = formatTime(accTime);

    if (allBpmReadings.length > 2) {
        const validReadings = allBpmReadings.filter(v => v > 30 && v < 220);
        if (validReadings.length > 0) {
            const lo = Math.min(...validReadings), hi = Math.max(...validReadings);
            els.finalRange.textContent = `${lo}–${hi}`;
        }
    } else {
        els.finalRange.textContent = '--';
    }

    const badge = els.confidenceBadge;
    badge.className = 'confidence-badge';
    if (signalConfidence > 0.5) {
        els.confidenceText.textContent = 'High Confidence';
        els.confidenceIcon.textContent = '●';
    } else if (signalConfidence > 0.25) {
        badge.classList.add('medium');
        els.confidenceText.textContent = 'Medium Confidence';
        els.confidenceIcon.textContent = '●';
    } else {
        badge.classList.add('low');
        els.confidenceText.textContent = 'Low Confidence';
        els.confidenceIcon.textContent = '●';
    }

    setState('complete');
}

let currentMode = 'heart';
const tabHeart = document.getElementById('tabHeart');
const tabBreath = document.getElementById('tabBreath');
const heartIdleContent = document.getElementById('heartIdleContent');
const breathIdleContent = document.getElementById('breathIdleContent');

tabHeart.addEventListener('click', () => switchMode('heart'));
tabBreath.addEventListener('click', () => switchMode('breath'));

function switchMode(mode) {
    currentMode = mode;
    tabHeart.classList.toggle('active', mode === 'heart');
    tabBreath.classList.toggle('active', mode === 'breath');
    heartIdleContent.classList.toggle('active', mode === 'heart');
    breathIdleContent.classList.toggle('active', mode === 'breath');
}

const VITALLENS_KEY = '4FWSfXkKWD5vAudERWnPM7rsFgwrecLp5Vq3Luuz';
let breathStream = null;
let breathTrack = null;
let vlInstance = null;
let breathInterval = null;
let breathStartTime = 0;
let lastBreathResult = null;
const BREATH_DURATION = 45000;

const breathEls = {};
['breathMeasuringState', 'breathStatusDot', 'breathStatusText', 'breathTimerDisplay',
    'breathVideo', 'breathRateNumber', 'breathHrNumber', 'breathProgressFill',
    'breathProgressPct', 'breathProgressHint', 'cancelBreathBtn', 'startBreathBtn',
    'completeLabel', 'completeUnit', 'metaRangeLabel'].forEach(id => {
        breathEls[id] = document.getElementById(id);
    });

function setStateAll(newState) {
    state = newState;
    els.idleState.classList.toggle('active', state === 'idle');
    els.measuringState.classList.toggle('active', state === 'measuring');
    breathEls.breathMeasuringState.classList.toggle('active', state === 'breathMeasuring');
    els.completeState.classList.toggle('active', state === 'complete');
}

setState = setStateAll;

async function startBreathMeasurement() {
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Camera API not available. Use HTTPS.');
        }

        breathStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });

        const videoEl = breathEls.breathVideo;
        videoEl.srcObject = breathStream;
        breathTrack = breathStream.getVideoTracks()[0];
        await videoEl.play();

        breathEls.breathRateNumber.textContent = '--';
        breathEls.breathHrNumber.textContent = '--';
        breathEls.breathProgressFill.style.width = '0%';
        breathEls.breathProgressPct.textContent = '0%';
        breathEls.breathStatusDot.className = 'detecting';
        breathEls.breathStatusText.textContent = 'Initializing camera...';
        breathEls.breathTimerDisplay.textContent = '0:00';
        lastBreathResult = null;

        setStateAll('breathMeasuring');
        breathStartTime = performance.now();

        breathInterval = setInterval(breathTick, 500);

        try {
            const mod = await import('https://cdn.jsdelivr.net/npm/vitallens');
            const VitalLens = mod.VitalLens || mod.default;

            vlInstance = new VitalLens({
                method: 'vitallens',
                apiKey: VITALLENS_KEY
            });

            vlInstance.addEventListener('vitals', (result) => {
                lastBreathResult = result;
                updateBreathDisplay(result);
            });

            await vlInstance.setVideoStream(breathStream, videoEl);

            breathEls.breathStatusText.textContent = 'Analyzing face...';

            vlInstance.startVideoStream();

        } catch (e) {
            console.warn('VitalLens API method failed, trying local POS:', e);
            try {
                const mod2 = await import('https://cdn.jsdelivr.net/npm/vitallens');
                const VitalLens2 = mod2.VitalLens || mod2.default;

                vlInstance = new VitalLens2({ method: 'pos' });

                vlInstance.addEventListener('vitals', (result) => {
                    lastBreathResult = result;
                    updateBreathDisplay(result);
                });

                await vlInstance.setVideoStream(breathStream, videoEl);
                vlInstance.startVideoStream();

                breathEls.breathStatusText.textContent = 'Analyzing (local mode)...';
            } catch (e2) {
                console.error('VitalLens all methods failed:', e2);
                breathEls.breathStatusText.textContent = 'SDK unavailable';
                breathEls.breathStatusDot.className = '';
            }
        }
    } catch (err) {
        console.error(err);
        alert(err.message.includes('Camera') ? err.message : 'Please grant camera permissions.');
        setStateAll('idle');
    }
}

function updateBreathDisplay(result) {
    if (!result) return;

    const vitals = result.vital_signs || result.vitals || result;
    const rr = vitals.respiratory_rate || vitals.respiratoryRate;
    const hr = vitals.heart_rate || vitals.heartRate;

    if (rr && (rr.value !== undefined && rr.value !== null)) {
        breathEls.breathRateNumber.textContent = Math.round(rr.value);
        breathEls.breathStatusDot.className = 'locked';
        breathEls.breathStatusText.textContent = 'Tracking breathing...';
    }
    if (hr && (hr.value !== undefined && hr.value !== null)) {
        breathEls.breathHrNumber.textContent = Math.round(hr.value);
    }
}

function breathTick() {
    if (state !== 'breathMeasuring') {
        clearInterval(breathInterval);
        return;
    }

    const elapsed = performance.now() - breathStartTime;
    const pct = Math.min(100, Math.floor(elapsed / BREATH_DURATION * 100));
    const secs = Math.floor(elapsed / 1000);

    breathEls.breathProgressFill.style.width = pct + '%';
    breathEls.breathProgressPct.textContent = pct + '%';
    breathEls.breathTimerDisplay.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    if (elapsed >= BREATH_DURATION) {
        finishBreathMeasurement();
    }
}

function stopBreathCamera() {
    clearInterval(breathInterval);
    if (vlInstance) {
        try { vlInstance.stopVideoStream?.(); } catch (e) { }
        try { vlInstance.close?.(); } catch (e) { }
        vlInstance = null;
    }
    if (breathTrack) breathTrack.stop();
    if (breathStream) breathStream.getTracks().forEach(t => t.stop());
    breathEls.breathVideo.srcObject = null;
    breathStream = null;
    breathTrack = null;
}

function cancelBreathMeasurement() {
    stopBreathCamera();
    setStateAll('idle');
}

function finishBreathMeasurement() {
    stopBreathCamera();

    const rrVal = parseInt(breathEls.breathRateNumber.textContent) || 0;
    const hrVal = parseInt(breathEls.breathHrNumber.textContent) || 0;

    document.getElementById('completeLabel').textContent = 'Your Breathing Rate';
    const bpmEl = document.getElementById('finalBpm');
    bpmEl.textContent = rrVal || '--';
    bpmEl.classList.add('breath-result');
    document.getElementById('completeUnit').textContent = 'BREATHS/MIN';
    els.finalDuration.textContent = formatTime(BREATH_DURATION);

    document.getElementById('metaRangeLabel').textContent = 'Heart Rate';
    els.finalRange.textContent = hrVal ? `${hrVal} BPM` : '--';

    const badge = els.confidenceBadge;
    badge.className = 'confidence-badge';
    const conf = lastBreathResult?.vital_signs?.respiratory_rate?.confidence ||
        lastBreathResult?.vitals?.respiratoryRate?.confidence || 0;
    if (conf > 0.7 || rrVal > 0) {
        els.confidenceText.textContent = rrVal ? 'Scan Complete' : 'Low Signal';
        if (!rrVal) badge.classList.add('low');
    } else {
        badge.classList.add('medium');
        els.confidenceText.textContent = 'Partial Signal';
    }
    els.confidenceIcon.textContent = '●';

    setStateAll('complete');
}

function resetCompleteForHeart() {
    document.getElementById('completeLabel').textContent = 'Your Heart Rate';
    document.getElementById('finalBpm').classList.remove('breath-result');
    document.getElementById('completeUnit').textContent = 'BPM';
    document.getElementById('metaRangeLabel').textContent = 'Range';
}

els.startBtn.addEventListener('click', () => { resetCompleteForHeart(); startMeasurement(); });
els.cancelBtn.addEventListener('click', cancelMeasurement);
breathEls.startBreathBtn.addEventListener('click', startBreathMeasurement);
breathEls.cancelBreathBtn.addEventListener('click', cancelBreathMeasurement);
els.restartBtn.addEventListener('click', () => {
    if (currentMode === 'breath') startBreathMeasurement();
    else { resetCompleteForHeart(); startMeasurement(); }
});
window.addEventListener('resize', () => { if (state === 'measuring') setupWaveformCanvas(); });