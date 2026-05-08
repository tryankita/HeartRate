# Heart Rate Monitor

A web-based Photoplethysmography (PPG) Heart Rate Monitor built with pure HTML, CSS, and JavaScript. 

It uses the camera on your mobile device to detect microscopic changes in the color of your fingertip as blood pumps through it, allowing it to calculate a live Beats Per Minute (BPM) and Heart Rate Variability (HRV) using the RMSSD method.

Live Demo: https://heart-rate-liard.vercel.app  
GitHub Repository: https://github.com/tryankita/HeartRate

Note: This requires a mobile device with a rear camera. 



### Prerequisites
You need Node.js and Python installed on your machine.

### 1. Start a local server
Open your terminal in the project directory and run:

    python -m http.server 8000

### 2. Create a secure tunnel
Open a second terminal window and run:

    npx localtunnel --port 8000

This will generate a random URL.

Open that exact HTTPS link on your mobile phone, click past the security warning, and you will be able to grant the camera permissions needed for the app to function.