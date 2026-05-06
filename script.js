const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const bpmValue = document.getElementById('bpmValue');
const pulseIndicator = document.getElementById('pulseIndicator');

let isReading = false;
let animationId = null;
let track = null;

const redValues = [];
const times = [];
const maxValuesToStore = 150; 
const bpmHistory = [];

startBtn.addEventListener('click', () => {
    if (isReading) {
        stopReading();
    } else {
        startReading();
    }
});

async function startReading() {
    try {
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 60 },
                height: { ideal: 60 }
            }
        });

        video.srcObject = stream;
        track = stream.getVideoTracks()[0];
        
        try {
            const capabilities = track.getCapabilities();
            if (capabilities.torch) {
                await track.applyConstraints({
                    advanced: [{ torch: true }]
                });
            }
        } catch (e) {
            console.warn("Torch API not supported or blocked (e.g., iOS Safari).", e);
        }

        video.play();
        isReading = true;
        startBtn.textContent = 'Stop Reading';
        bpmValue.textContent = '...';
        
        setTimeout(() => {
            processFrame();
        }, 1000);

    } catch (err) {
        console.error("Camera access denied or unavailable: ", err);
        alert("Please grant camera permissions to use the Heart Rate Monitor.");
    }
}

function stopReading() {
    bpmHistory.length = 0;
    isReading = false;
    startBtn.textContent = 'Start Reading';
    if (animationId) cancelAnimationFrame(animationId);
    if (track) track.stop();
    video.srcObject = null;
    bpmValue.textContent = '--';
    redValues.length = 0;
    times.length = 0;
}

function processFrame() {
    if (!isReading) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let redSum = 0;
    
    for (let i = 0; i < frame.data.length; i += 4) {
        redSum += frame.data[i];     
    }
    const redAverage = redSum / (frame.data.length / 4);

    redValues.push(redAverage);
    times.push(performance.now());

    if (redValues.length > maxValuesToStore) {
        redValues.shift();
        times.shift();
    }

    calculateBPM();

    animationId = requestAnimationFrame(processFrame);
}

function calculateBPM() {
    if (redValues.length < 50) return; 

    const filterWindow = 4;
    let smoothed = [];
    for (let i = 0; i < redValues.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - filterWindow); j <= Math.min(redValues.length - 1, i + filterWindow); j++) {
            sum += redValues[j];
            count++;
        }
        smoothed.push(sum / count);
    }

    const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
    const min = Math.min(...smoothed);
    const max = Math.max(...smoothed);
    const amplitude = max - min;
    
    if (amplitude < 1.5) {
        bpmValue.textContent = '--';
        bpmHistory.length = 0; 
        return;
    }

    let peaks = [];
    const minInterBe   atInterval = 300; 

    for (let i = 1; i < smoothed.length - 1; i++) {
        const val = smoothed[i];
        
        if (val > smoothed[i - 1] && val > smoothed[i + 1] && val > mean + (amplitude * 0.1)) {
            if (peaks.length === 0 || (times[i] - peaks[peaks.length - 1].time) > minInterBeatInterval) {
                peaks.push({ time: times[i], value: val });
            }
        }
    }

    if (peaks.length > 2) {
        let intervalsSum = 0;
        for (let i = 1; i < peaks.length; i++) {
            intervalsSum += (peaks[i].time - peaks[i - 1].time);
        }
        
        let avgInterval = intervalsSum / (peaks.length - 1);
        let currentBpm = Math.round(60000 / avgInterval);
        
        if (currentBpm > 40 && currentBpm < 200) {
            
            pulseIndicator.classList.remove('beat');
            void pulseIndicator.offsetWidth; 
            pulseIndicator.classList.add('beat');

            bpmHistory.push(currentBpm);
            if (bpmHistory.length > 5) bpmHistory.shift(); 
            
            let stableBpm = Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length);
            bpmValue.textContent = stableBpm;
        }
    }
}


document.addEventListener('DOMContentLoaded', () => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (!isMobile) {
        document.getElementById('desktopWarning').classList.add('visible');
    }
    drawChart();
});

const chartCanvas = document.getElementById('chartCanvas');
const chartCtx = chartCanvas.getContext('2d');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

clearHistoryBtn.addEventListener('click', () => {
    localStorage.removeItem('heartRateHistory');
    drawChart();
});

function stopReading() {
    isReading = false;
    startBtn.textContent = 'Start Reading';
    if (animationId) cancelAnimationFrame(animationId);
    if (track) track.stop();
    video.srcObject = null;
    
    if (bpmHistory.length > 0) {
        const sessionAverage = Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length);
        saveBpmToHistory(sessionAverage);
    }
    
    bpmValue.textContent = '--';
    redValues.length = 0;
    times.length = 0;
    bpmHistory.length = 0;
}

function saveBpmToHistory(bpm) {
    let history = JSON.parse(localStorage.getItem('heartRateHistory') || '[]');
    history.push({ bpm: bpm, timestamp: Date.now() });
    
    if (history.length > 20) {
        history = history.slice(history.length - 20);
    }
    
    localStorage.setItem('heartRateHistory', JSON.stringify(history));
    drawChart();
}

function drawChart() {
    const history = JSON.parse(localStorage.getItem('heartRateHistory') || '[]');
    const width = chartCanvas.width;
    const height = chartCanvas.height;
    
    chartCtx.clearRect(0, 0, width, height);
    
    if (history.length === 0) {
        chartCtx.fillStyle = 'rgba(45, 42, 38, 0.4)';
        chartCtx.font = '12px Inter';
        chartCtx.textAlign = 'center';
        chartCtx.fillText('No history available', width / 2, height / 2);
        return;
    }

    const padding = 20;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;
    
    const maxBpm = Math.max(...history.map(d => d.bpm), 120);
    const minBpm = Math.min(...history.map(d => d.bpm), 60);
    const range = maxBpm - minBpm || 1;

    chartCtx.beginPath();
    chartCtx.strokeStyle = '#b8815c';
    chartCtx.lineWidth = 2;
    chartCtx.lineJoin = 'round';

    history.forEach((dataPoint, index) => {
        const x = padding + (index / Math.max(history.length - 1, 1)) * graphWidth;
        const y = height - padding - ((dataPoint.bpm - minBpm) / range) * graphHeight;
        
        if (index === 0) {
            chartCtx.moveTo(x, y);
        } else {
            chartCtx.lineTo(x, y);
        }
    });
    
    chartCtx.stroke();

    history.forEach((dataPoint, index) => {
        const x = padding + (index / Math.max(history.length - 1, 1)) * graphWidth;
        const y = height - padding - ((dataPoint.bpm - minBpm) / range) * graphHeight;
        
        chartCtx.beginPath();
        chartCtx.arc(x, y, 4, 0, Math.PI * 2);
        chartCtx.fillStyle = '#ffffff';
        chartCtx.fill();
        chartCtx.lineWidth = 2;
        chartCtx.strokeStyle = '#b8815c';
        chartCtx.stroke();
        
        if (index === history.length - 1 || index === 0) {
            chartCtx.fillStyle = '#2d2a26';
            chartCtx.font = '10px Inter';
            chartCtx.textAlign = index === 0 ? 'left' : 'right';
            chartCtx.fillText(`${dataPoint.bpm} bpm`, x, y - 10);
        }
    });
}