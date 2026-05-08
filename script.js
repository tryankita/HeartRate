document.addEventListener('DOMContentLoaded', () => {
    // Check if device is desktop
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // Modal Logic
    const modal = document.getElementById('desktopModal');
    const closeBtn = document.getElementById('closeModalBtn');
    
    if (!isMobile && modal) {
        // slight delay to allow the aesthetic backdrop blur to fade in elegantly
        setTimeout(() => {
            modal.classList.add('show');
        }, 100);
    }
    
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => {
            modal.classList.remove('show');
        });
    }
    
    drawChart();
});

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const bpmValue = document.getElementById('bpmValue');
const hrvValue = document.getElementById('hrvValue');
const pulseIndicator = document.getElementById('pulseIndicator');
const chartCanvas = document.getElementById('chartCanvas');
const chartCtx = chartCanvas.getContext('2d');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

let isReading = false;
let animationId = null;
let track = null;
let readingTimer = null; // Auto-stop timer

const redValues = [];
const times = [];
const maxValuesToStore = 150; 
const bpmHistory = [];
let lastProcessedPeakTime = 0;
let sessionBpmSum = 0;
let sessionBpmCount = 0;

startBtn.addEventListener('click', () => {
    if (isReading) {
        stopReading();
    } else {
        startReading();
    }
});

clearHistoryBtn.addEventListener('click', () => {
    localStorage.removeItem('heartRateHistory');
    drawChart();
});

exportCsvBtn.addEventListener('click', () => {
    const history = JSON.parse(localStorage.getItem('heartRateHistory') || '[]');
    if (history.length === 0) {
        alert('No data to export.');
        return;
    }
    
    let csvContent = "data:text/csv;charset=utf-8,Date,Time,BPM\n";
    history.forEach(entry => {
        const dateObj = new Date(entry.timestamp);
        const dateStr = dateObj.toLocaleDateString();
        const timeStr = dateObj.toLocaleTimeString();
        csvContent += `${dateStr},${timeStr},${entry.bpm}\n`;
    });
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "heart_rate_data.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

async function startReading() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Camera API not available. This usually means you are not using HTTPS.");
        }
        
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
            console.warn("Torch API not supported or blocked.", e);
        }

        video.play();
        isReading = true;
        startBtn.textContent = 'Stop Reading';
        bpmValue.textContent = '...';
        if (hrvValue) hrvValue.textContent = '--';
        
        setTimeout(() => {
            processFrame();
            
            // Automatically stop reading after 1 minute (60,000 ms)
            readingTimer = setTimeout(() => {
                if (isReading) {
                    stopReading();
                    alert("1 minute reading completed. Data saved!");
                }
            }, 60000);
        }, 1000);

    } catch (err) {
        console.error("Camera access denied or unavailable: ", err);
        alert(err.message === "Camera API not available. This usually means you are not using HTTPS." ? err.message : "Please grant camera permissions to use the Heart Rate Monitor.");
    }
}

function stopReading() {
    isReading = false;
    startBtn.textContent = 'Start Reading';
    if (animationId) cancelAnimationFrame(animationId);
    if (track) track.stop();
    video.srcObject = null;
    if (readingTimer) clearTimeout(readingTimer);
    
    if (sessionBpmCount > 0) {
        const sessionAverage = Math.round(sessionBpmSum / sessionBpmCount);
        saveBpmToHistory(sessionAverage);
        bpmValue.textContent = sessionAverage; // Show final stable result
    } else {
        bpmValue.textContent = '--';
        if (hrvValue) hrvValue.textContent = '--';
    }
    
    redValues.length = 0;
    times.length = 0;
    bpmHistory.length = 0;
    lastProcessedPeakTime = 0;
    sessionBpmSum = 0;
    sessionBpmCount = 0;
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

    // Apply a Simple Moving Average (SMA) filter to remove high-frequency camera noise
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
        if (hrvValue) hrvValue.textContent = '--';
        bpmHistory.length = 0; 
        return;
    }

    let peaks = [];
    const minInterBeatInterval = 300; 

    for (let i = 1; i < smoothed.length - 1; i++) {
        const val = smoothed[i];
        
        if (val > smoothed[i - 1] && val > smoothed[i + 1] && val > mean + (amplitude * 0.1)) {
            if (peaks.length === 0 || (times[i] - peaks[peaks.length - 1].time) > minInterBeatInterval) {
                peaks.push({ time: times[i], value: val });
            }
        }
    }

    if (peaks.length > 2) {
        let lastPeakTime = peaks[peaks.length - 1].time;
        if (lastProcessedPeakTime === lastPeakTime) return; // Wait for a new real heartbeat
        lastProcessedPeakTime = lastPeakTime;

        let rrIntervals = [];
        for (let i = 1; i < peaks.length; i++) {
            rrIntervals.push(peaks[i].time - peaks[i - 1].time);
        }
        
        // Calculate the current immediate BPM from recent beat intervals
        let avgInterval = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
        let currentBpm = Math.round(60000 / avgInterval);
        
        if (currentBpm > 40 && currentBpm < 200) {
            pulseIndicator.classList.remove('beat');
            void pulseIndicator.offsetWidth; 
            pulseIndicator.classList.add('beat');

            bpmHistory.push(currentBpm);
            
            // Allow 8 new distinct heart beats to stabilize before displaying
            if (bpmHistory.length >= 8) {
                // Keep the last 15 distinct heartbeats for a steady rolling average
                if (bpmHistory.length > 15) bpmHistory.shift(); 
                
                let steadyBpm = Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length);
                bpmValue.textContent = steadyBpm;
                
                // Add to our full 1-minute session sum to get the true average on completion
                sessionBpmSum += steadyBpm;
                sessionBpmCount++;

                // Calculate HRV using RMSSD (Root Mean Square of Successive Differences)
                if (rrIntervals.length > 1) {
                    let sumOfSquaredDifferences = 0;
                    for (let i = 1; i < rrIntervals.length; i++) {
                        let diff = rrIntervals[i] - rrIntervals[i - 1];
                        sumOfSquaredDifferences += (diff * diff);
                    }
                    let rmssd = Math.sqrt(sumOfSquaredDifferences / (rrIntervals.length - 1));
                    
                    if (rmssd > 0 && rmssd < 200) {
                        if (hrvValue) hrvValue.textContent = Math.round(rmssd);
                    }
                }
            } else {
                // Display a "loading" state while stabilizing
                bpmValue.textContent = '...';
            }
        }
    }
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
    chartCtx.strokeStyle = '#d96c4a'; // updated to new accent color
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

    // Draw data points
    history.forEach((dataPoint, index) => {
        const x = padding + (index / Math.max(history.length - 1, 1)) * graphWidth;
        const y = height - padding - ((dataPoint.bpm - minBpm) / range) * graphHeight;
        
        chartCtx.beginPath();
        chartCtx.arc(x, y, 4, 0, Math.PI * 2);
        chartCtx.fillStyle = '#ffffff';
        chartCtx.fill();
        chartCtx.lineWidth = 2;
        chartCtx.strokeStyle = '#d96c4a'; // updated to new accent color
        chartCtx.stroke();
        
        if (index === history.length - 1 || index === 0) {
            chartCtx.fillStyle = '#2c2b29'; // updated to new text color
            chartCtx.font = '10px Inter';
            chartCtx.textAlign = index === 0 ? 'left' : 'right';
            chartCtx.fillText(`${dataPoint.bpm} bpm`, x, y - 10);
        }
    });
}