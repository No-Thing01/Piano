// AudioContext Setup
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;
let masterGainNode;
let convolverNode;

// Note Mapping
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const keyToNoteMap = {
    'a': 'C', 'w': 'C#', 's': 'D', 'e': 'D#', 'd': 'E', 'f': 'F',
    't': 'F#', 'g': 'G', 'y': 'G#', 'h': 'A', 'u': 'A#', 'j': 'B'
};

// Active notes tracking (to allow stopping them)
const activeNotes = {};

// State Variables
let currentOctave = 0; 
let isRecording = false;
let isPlaying = false;
let recordingStartTime = 0;
let recordedSequence = []; // { type: 'on'/'off', note, time, octave, vel }
let playbackTimeouts = [];
let isMouseDown = false;
let reverbEnabled = false;

// Initialize Audio Engine
function initAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
        
        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.value = document.getElementById('volume-slider') ? parseFloat(document.getElementById('volume-slider').value) : 0.5;
        masterGainNode.connect(audioCtx.destination);
        
        createReverb();
        initMIDI();
        
        console.log("Synthesizer engine initialized.");
    }
}

function createReverb() {
    const rate = audioCtx.sampleRate;
    const length = rate * 2.5; 
    const impulse = audioCtx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    
    for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 3);
        left[i] = (Math.random() * 2 - 1) * decay;
        right[i] = (Math.random() * 2 - 1) * decay;
    }
    
    convolverNode = audioCtx.createConvolver();
    convolverNode.buffer = impulse;
    convolverNode.connect(masterGainNode);
}

// MIDI Setup
function initMIDI() {
    if (navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess().then(
            (midiAccess) => {
                for (var input of midiAccess.inputs.values()) {
                    input.onmidimessage = handleMIDIMessage;
                }
            },
            () => console.warn("Could not access your MIDI devices.")
        );
    }
}

function handleMIDIMessage(message) {
    const command = message.data[0];
    const note = message.data[1]; // 0-127
    const velocity = (message.data.length > 2) ? message.data[2] : 0;
    
    if (command === 144 && velocity > 0) { 
        const noteName = noteNames[note % 12];
        const relativeOctave = Math.floor(note / 12) - 6; 
        
        playNote(noteName, relativeOctave, velocity / 127);
        
        const keyId = Object.keys(keyToNoteMap).find(key => keyToNoteMap[key] === noteName);
        if (keyId) {
            const button = document.getElementById('btn-' + keyId);
            if (button) button.classList.add('active');
        }
    } else if (command === 128 || (command === 144 && velocity === 0)) { 
        const noteName = noteNames[note % 12];
        const relativeOctave = Math.floor(note / 12) - 6; 
        
        stopNote(noteName, relativeOctave);
        
        const keyId = Object.keys(keyToNoteMap).find(key => keyToNoteMap[key] === noteName);
        if (keyId) {
            const button = document.getElementById('btn-' + keyId);
            if (button) button.classList.remove('active');
        }
    }
}

// Frequency Calculation
function getFrequency(noteName, octaveShift) {
    // Base is C5 = MIDI note 72
    const baseMidiNote = 72;
    const noteIndex = noteNames.indexOf(noteName);
    const actualMidiNote = baseMidiNote + noteIndex + (octaveShift * 12);
    return 440 * Math.pow(2, (actualMidiNote - 69) / 12);
}

// Play Note (Synthesizer Engine)
function playNote(noteName, forceOctave = null, velocity = 1.0, isPlayback = false) {
    if (!audioCtx) initAudio(); 
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const octaveToUse = forceOctave !== null ? forceOctave : currentOctave;
    
    // Unique ID for tracking the active note
    const noteId = `${noteName}-${octaveToUse}`;
    
    // If note is already playing, stop it first to prevent overlapping buildup
    if (activeNotes[noteId]) {
        stopNote(noteName, octaveToUse, isPlayback);
    }

    if (isRecording && !isPlayback) {
        recordedSequence.push({ 
            type: 'on', note: noteName, 
            time: audioCtx.currentTime - recordingStartTime, 
            octave: octaveToUse, vel: velocity 
        });
    }

    const freq = getFrequency(noteName, octaveToUse);

    // Create Oscillators (Layering for Electric Piano sound)
    const osc1 = audioCtx.createOscillator();
    osc1.type = 'sine'; // Soft sine wave base
    osc1.frequency.value = freq;
    
    const osc2 = audioCtx.createOscillator();
    osc2.type = 'triangle'; // Triangle for slight harmonic richness
    osc2.frequency.value = freq;
    osc2.detune.value = 5; 

    // ADSR Envelope Node
    const envNode = audioCtx.createGain();
    
    // Attack phase (Percussive attack, smooth decay)
    envNode.gain.setValueAtTime(0, audioCtx.currentTime);
    envNode.gain.linearRampToValueAtTime(velocity * 0.8, audioCtx.currentTime + 0.015); // Fast attack 15ms
    envNode.gain.exponentialRampToValueAtTime(velocity * 0.3, audioCtx.currentTime + 1.5); // Slow decay to sustain

    // Filter Node (to soften the overall sound)
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800 + (velocity * 1200);
    
    // Routing
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(envNode);
    
    if (reverbEnabled && convolverNode) {
        envNode.connect(convolverNode);
    } else {
        envNode.connect(masterGainNode);
    }
    
    osc1.start();
    osc2.start();

    // Store references to stop them later
    activeNotes[noteId] = { osc1, osc2, envNode };
}

// Stop Note (Release Phase)
function stopNote(noteName, forceOctave = null, isPlayback = false) {
    const octaveToUse = forceOctave !== null ? forceOctave : currentOctave;
    const noteId = `${noteName}-${octaveToUse}`;
    
    if (isRecording && !isPlayback) {
        recordedSequence.push({ 
            type: 'off', note: noteName, 
            time: audioCtx.currentTime - recordingStartTime, 
            octave: octaveToUse 
        });
    }

    if (activeNotes[noteId]) {
        const { osc1, osc2, envNode } = activeNotes[noteId];
        
        // Release phase (fade out)
        envNode.gain.cancelScheduledValues(audioCtx.currentTime);
        envNode.gain.setValueAtTime(envNode.gain.value, audioCtx.currentTime);
        envNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3); // 300ms release
        
        // Stop oscillators after release
        osc1.stop(audioCtx.currentTime + 0.3);
        osc2.stop(audioCtx.currentTime + 0.3);
        
        delete activeNotes[noteId];
    }
}

// UI Controllers
document.addEventListener('DOMContentLoaded', () => {
    // --- Keyboard Input ---
    document.addEventListener('keydown', (event) => {
        if (event.repeat) return;
        
        const key = event.key.toLowerCase();
        const note = keyToNoteMap[key];
        
        if (note) {
            const button = document.getElementById('btn-' + key);
            if (button) button.classList.add('active');
            playNote(note);
        }
    });

    document.addEventListener('keyup', (event) => {
        const key = event.key.toLowerCase();
        const note = keyToNoteMap[key];
        
        if (note) {
            const button = document.getElementById('btn-' + key);
            if (button) button.classList.remove('active');
            stopNote(note);
        }
    });

    // --- Mouse Input (with Glissando) ---
    const keys = document.querySelectorAll('.piano button');
    
    document.body.addEventListener('click', () => {
        if (!audioCtx) initAudio();
    }, { once: true });

    document.addEventListener('mousedown', () => isMouseDown = true);
    document.addEventListener('mouseup', () => {
        isMouseDown = false;
        // Turn off any keys that might be active but missed mouseleave
        keys.forEach(k => {
            if (k.classList.contains('active')) {
                k.classList.remove('active');
                const note = k.getAttribute('data-note');
                if (note) stopNote(note);
            }
        });
    });

    keys.forEach(key => {
        key.addEventListener('mousedown', () => {
            const note = key.getAttribute('data-note');
            if (note) {
                playNote(note);
                key.classList.add('active');
            }
        });
        
        key.addEventListener('mouseenter', () => {
            if (isMouseDown) {
                const note = key.getAttribute('data-note');
                if (note) {
                    playNote(note);
                    key.classList.add('active');
                }
            }
        });

        key.addEventListener('mouseleave', () => {
            if (key.classList.contains('active')) {
                key.classList.remove('active');
                const note = key.getAttribute('data-note');
                if (note) stopNote(note);
            }
        });

        // Touch events for mobile
        key.addEventListener('touchstart', (e) => {
            e.preventDefault(); // Prevent scrolling and double firing
            if (!audioCtx) initAudio();
            const note = key.getAttribute('data-note');
            if (note) {
                playNote(note);
                key.classList.add('active');
            }
        });

        key.addEventListener('touchend', (e) => {
            e.preventDefault();
            if (key.classList.contains('active')) {
                key.classList.remove('active');
                const note = key.getAttribute('data-note');
                if (note) stopNote(note);
            }
        });

        key.addEventListener('touchcancel', (e) => {
            e.preventDefault();
            if (key.classList.contains('active')) {
                key.classList.remove('active');
                const note = key.getAttribute('data-note');
                if (note) stopNote(note);
            }
        });
    });

    // --- Control Panel ---
    const volSlider = document.getElementById('volume-slider');
    const octUpBtn = document.getElementById('btn-octave-up');
    const octDownBtn = document.getElementById('btn-octave-down');
    const octDisplay = document.getElementById('octave-display');
    const recBtn = document.getElementById('btn-record');
    const stopBtn = document.getElementById('btn-stop');
    const playBtn = document.getElementById('btn-play');
    const reverbToggle = document.getElementById('reverb-toggle');

    volSlider.addEventListener('input', (e) => {
        if (masterGainNode) {
            masterGainNode.gain.value = parseFloat(e.target.value);
        } else {
            initAudio();
            masterGainNode.gain.value = parseFloat(e.target.value);
        }
    });

    octUpBtn.addEventListener('click', () => {
        if (currentOctave < 2) currentOctave++;
        updateOctaveDisplay();
    });
    
    octDownBtn.addEventListener('click', () => {
        if (currentOctave > -2) currentOctave--;
        updateOctaveDisplay();
    });

    function updateOctaveDisplay() {
        let sign = currentOctave > 0 ? '+' : '';
        octDisplay.textContent = currentOctave === 0 ? '0' : `${sign}${currentOctave}`;
    }

    reverbToggle.addEventListener('change', (e) => {
        if (!audioCtx) initAudio();
        reverbEnabled = e.target.checked;
    });

    // Recording
    recBtn.addEventListener('click', () => {
        if (!audioCtx) initAudio();
        stopPlayback(); 
        isRecording = true;
        recordedSequence = [];
        recordingStartTime = audioCtx.currentTime;
        
        recBtn.classList.add('recording');
        playBtn.classList.remove('playing');
    });

    stopBtn.addEventListener('click', () => {
        isRecording = false;
        recBtn.classList.remove('recording');
        stopPlayback();
    });

    playBtn.addEventListener('click', () => {
        if (recordedSequence.length === 0) return;
        
        isRecording = false;
        recBtn.classList.remove('recording');
        stopPlayback(); 
        
        playBtn.classList.add('playing');
        isPlaying = true;

        recordedSequence.forEach(event => {
            const timeoutId = setTimeout(() => {
                const keyId = Object.keys(keyToNoteMap).find(key => keyToNoteMap[key] === event.note);
                const button = keyId ? document.getElementById('btn-' + keyId) : null;
                
                if (event.type === 'on') {
                    playNote(event.note, event.octave, event.vel, true);
                    if (button) button.classList.add('active');
                } else if (event.type === 'off') {
                    stopNote(event.note, event.octave, true);
                    if (button) button.classList.remove('active');
                }

                if (event === recordedSequence[recordedSequence.length - 1]) {
                    setTimeout(() => playBtn.classList.remove('playing'), 500);
                }
            }, event.time * 1000);
            
            playbackTimeouts.push(timeoutId);
        });
    });

    function stopPlayback() {
        playbackTimeouts.forEach(id => clearTimeout(id));
        playbackTimeouts = [];
        playBtn.classList.remove('playing');
        isPlaying = false;
        // Kill all playing notes
        Object.keys(activeNotes).forEach(noteId => {
            const parts = noteId.split('-');
            stopNote(parts[0], parseInt(parts[1]), true);
        });
        keys.forEach(k => k.classList.remove('active'));
    }
});
