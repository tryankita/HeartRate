const video = document.getElementById('video');
const canvas = document.getElementById('offscreenCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const uiContainer = document.getElementById('uiContainer');
const progressCard = document.getElementById('progressCard');
const measurementArea = document.getElementById('measurementArea');
const progressRing = document.getElementById('progressRing');
const progressText = document.getElementById('progressText');
const pulseCircle = document.getElementById('pulseCircle');
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformCtx = waveformCanvas.getContext('2d');
const bpmValueDisplay = document.getElementById('bpmValueDisplay');
const startBtn = document.getElementById('startBtn');

let isReading = false;
let animationId = null;
let track = null;

// robust signal metrics
const rawSignal = [];
const timestamps = [];
const historyWindow = 200; // frames
const fps = 30;

let bpmRollingBuffer = [];
let progress = 0; // 0 to 100
const maxDuration = 30000; // 30 seconds measurement
let accumulatedTime = 0;
let lastFrameTime = 0;
let fingerOffFrames = 0;

startBtn.addEventListener('click', async () => {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Camera API not available. Ensure HTTPS.");
        }
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 120 }, height: { ideal: 120 } }
        });

        video.srcObject = stream;
        track = stream.getVideoTracks()[0];
        
        try {
            const capabilities = track.getCapabilities();
            if (capabilities.torch) {
                await track.applyConstraints({ advanced: [{ torch: true }] });
            }
        } catch (e) {
            console.warn("Torch not supported/blocked.", e);
        }

        video.play();
        isReading = true;
        
        // UI prep
        startBtn.classList.add('hidden');
        progressCard.classList.remove('hidden');
        measurementArea.classList.remove('hidden');
        bpmRollingBuffer = [];
        rawSignal.length = 0;
        timestamps.length = 0;
        progress = 0;
        updateProgressUI(0);
        bpmValueDisplay.textContent = "-- bpm";
        uiContainer.classList.remove('finger-on');
        
        setTimeout(() => {
            lastFrameTime = performance.now();
            accumulatedTime = 0;
            processFrame();
        }, 1000);

    } catch (err) {
        console.error(err);
        alert(err.message === "Camera API not available. Ensure HTTPS." ? err.message : "Please grant camera permissions.");
    }
});

function stopReading() {
    isReading = false;
    startBtn.classList.remove('hidden');
    startBtn.textContent = 'Restart';
    progressCard.classList.add('hidden');
    uiContainer.classList.remove('finger-on');
    
    if (animationId) cancelAnimationFrame(animationId);
    if (track) track.stop();
    video.srcObject = null;
}

function processFrame() {
    if (!isReading) return;

    const timeNow = performance.now();
    const deltaTime = timeNow - lastFrameTime;
    lastFrameTime = timeNow;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    let redSum = 0;
    let greenSum = 0;

    // subsample pixels for speed
    for (let i = 0; i < frame.data.length; i += 16) {
        redSum += frame.data[i];
        greenSum += frame.data[i+1];
    }
    
    const count = frame.data.length / 16;
    const avgR = redSum / count;
    const avgG = greenSum / count;

    // Signal extraction standard: finger over camera saturates red
    // Red gives volume, but green often gives sharper AC pulses if light penetrates
    // Combining them or just using Red depending on saturation. Using average.
    const signal = (avgR + avgG) / 2;

    // Detect if finger covers lens (Red dominates)
    const currentFingerOn = (avgR > 80 && avgR > avgG * 1.1);

    if (currentFingerOn) {
        fingerOffFrames = 0;
    } else {
        fingerOffFrames++;
    }

    // Debounce the removal so micro-adjustments don't flash a flatline
    const isFingerOnCamera = (fingerOffFrames < 15);

    // Always log data so we have a continuous history window
    rawSignal.push(signal);
    timestamps.push(timeNow);
    if (rawSignal.length > historyWindow) {
        rawSignal.shift();
        timestamps.shift();
    }

    if (isFingerOnCamera) {
        uiContainer.classList.add('finger-on');
        
        accumulatedTime += deltaTime;
        calculateBPM();
        drawWaveform(false);

        // Update progress
        progress = Math.min(100, Math.floor((accumulatedTime / maxDuration) * 100));
        updateProgressUI(progress);

        if (progress >= 100) {
            stopReading();
            return;
        }
    } else {
        uiContainer.classList.remove('finger-on');
        // Do not accumulate time, clear buffer
        bpmRollingBuffer = []; 
        drawWaveform(true); // Draw flatline
    }

    animationId = requestAnimationFrame(processFrame);
}

// ----------------------------------------------------
// Robust Processing Algorithm (Google Fit style)
// ----------------------------------------------------
function calculateBPM() {
    if (rawSignal.length < 60) return; // Need ~2 seconds of min data

    // 1. Smoothing (Moving Average)
    const windowSm = 5;
    let smoothed = [];
    for (let i = windowSm; i < rawSignal.length - windowSm; i++) {
        let sum = 0;
        for (let j = -windowSm; j <= windowSm; j++) sum += rawSignal[i + j];
        smoothed.push(sum / (2 * windowSm + 1));
    }

    // 2. Detrending (Remove DC wander)
    const windowTr = 15;
    let detrended = [];
    for (let i = windowTr; i < smoothed.length - windowTr; i++) {
        let trendSum = 0;
        for (let j = -windowTr; j <= windowTr; j++) trendSum += smoothed[i + j];
        const trend = trendSum / (2 * windowTr + 1);
        // Multiply detrended signal to amplify the tiny AC component
        detrended.push((smoothed[i] - trend) * -1); // Inverting so volume push = peak
    }

    // 3. Peak Detection with Dynamic Threshold
    const minDistance = 350; // max ~170 BPM
    let peaks = [];
    let lastPeakTime = 0;
    
    // offset because of filtering loss
    const offset = windowSm + windowTr;

    // dynamic threshold
    let threshold = 0;
    if (detrended.length > 0) {
        const sorted = [...detrended].sort((a,b)=>a-b);
        // top 20% intensity
        threshold = sorted[Math.floor(sorted.length * 0.8)] * 0.5;
    }

    for (let i = 1; i < detrended.length - 1; i++) {
        const prev = detrended[i - 1];
        const curr = detrended[i];
        const next = detrended[i + 1];

        if (curr > prev && curr > next && curr > threshold) {
            const time = timestamps[i + offset];
            if (time - lastPeakTime > minDistance) {
                peaks.push({ val: curr, time: time });
                lastPeakTime = time;
                
                // Animate circle on peak if it's the very latest one
                if (i > detrended.length - 10) {
                    pulseCircle.classList.add('beat');
                    setTimeout(() => pulseCircle.classList.remove('beat'), 100);
                }
            }
        }
    }

    // 4. Calculate BPM
    if (peaks.length < 3) return;

    let intervals = [];
    for (let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i].time - peaks[i - 1].time);
    }

    // Reject outliers in intervals (extrasystoles or noise)
    const avgInt = intervals.reduce((a,b)=>a+b)/intervals.length;
    intervals = intervals.filter(int => Math.abs(int - avgInt) < avgInt * 0.3);
    
    if (intervals.length < 2) return;

    const filteredAvgInt = intervals.reduce((a,b)=>a+b)/intervals.length;
    let bpm = Math.round(60000 / filteredAvgInt);

    if (bpm > 40 && bpm < 200) {
        bpmRollingBuffer.push(bpm);
        if (bpmRollingBuffer.length > 10) bpmRollingBuffer.shift();
        
        let steadyBpm = Math.round(bpmRollingBuffer.reduce((a,b)=>a+b)/bpmRollingBuffer.length);
        bpmValueDisplay.textContent = `${steadyBpm} bpm`;
    }
}

function updateProgressUI(pct) {
    progressText.textContent = `${pct}%`;
    const offset = 138 - (pct / 100) * 138;
    progressRing.style.strokeDashoffset = offset;
}

function drawWaveform(flat = false) {
    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    waveformCtx.beginPath();
    waveformCtx.strokeStyle = "#fff";
    waveformCtx.lineWidth = 2;
    waveformCtx.lineJoin = "round";

    if (flat || rawSignal.length < 30) {
        waveformCtx.moveTo(0, waveformCanvas.height / 2);
        waveformCtx.lineTo(waveformCanvas.width, waveformCanvas.height / 2);
        waveformCtx.stroke();
        return;
    }

    // Detrend just for display visuals
    let displaySignal = [];
    const w = 5;
    for (let i = w; i < rawSignal.length - w; i++) {
        let trend = 0;
        for (let j = -w; j <= w; j++) trend += rawSignal[i + j];
        displaySignal.push(rawSignal[i] - (trend / (2*w+1)));
    }

    const min = Math.min(...displaySignal);
    const max = Math.max(...displaySignal);
    const range = (max - min) || 1;

    for (let i = 0; i < displaySignal.length; i++) {
        const x = (i / displaySignal.length) * waveformCanvas.width;
        // Normalize and scale to canvas height, inverted
        const y = waveformCanvas.height - ((displaySignal[i] - min) / range) * (waveformCanvas.height * 0.8) - (waveformCanvas.height * 0.1);
        
        if (i === 0) waveformCtx.moveTo(x, y);
        else waveformCtx.lineTo(x, y);
    }
    waveformCtx.stroke();
}