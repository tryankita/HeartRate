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
    
    let peaks = [];
    
    for (let i = 2; i < redValues.length - 2; i++) {
        const val = redValues[i];
        if (
            val > redValues[i - 1] &&
            val > redValues[i - 2] &&
            val > redValues[i + 1] &&
            val > redValues[i + 2]
        ) {
            
            if (peaks.length === 0 || (times[i] - peaks[peaks.length - 1].time) > 300) {
                peaks.push({ time: times[i], value: val });
                
                pulseIndicator.classList.add('beat');
                setTimeout(() => pulseIndicator.classList.remove('beat'), 100);
            }
        }
    }

    if (peaks.length > 2) {
        
        let intervalsSum = 0;
        for (let i = 1; i < peaks.length; i++) {
            intervalsSum += (peaks[i].time - peaks[i - 1].time);
        }
        let avgInterval = intervalsSum / (peaks.length - 1);
        
        let bpm = Math.round(60000 / avgInterval);
        
        if (bpm > 40 && bpm < 200) {
            bpmValue.textContent = bpm;
        }
    }
}