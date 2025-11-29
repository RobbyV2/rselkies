/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Microphone capture and transmission for bidirectional audio
 * Handles getUserMedia permissions, audio processing, and WebRTC transmission
 */
class MicrophoneManager {
    constructor(webrtcDemo) {
        this.webrtcDemo = webrtcDemo;
        this.audioContext = null;
        this.mediaStream = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.isEnabled = false;
        this.isTransmitting = false;
        
        // Audio processing settings - Match server expectations
        this.sampleRate = 24000; // Server expects 24kHz
        this.channels = 1; // Mono for microphone
        this.bufferSize = 2048; // Smaller buffer for lower latency
        this.silenceThreshold = 0.01; // Threshold for silence detection

        // WebSocket connection for audio data
        this.dataWebSocket = null;
        
        // Opus encoding simulation (would need real opus encoder)
        this.audioBuffer = [];
        this.packetDuration = 10; // 10ms packets as mentioned in requirements
        
        this.onstatuschange = null;
        this.onerror = null;
        this.ondebug = null;
    }

    /**
     * Request microphone permissions and initialize audio context
     */
    async requestPermissions() {
        try {
            this._setStatus("Requesting microphone permissions...");
            
            const constraints = {
                audio: {
                    channelCount: this.channels,
                    sampleRate: { ideal: this.sampleRate },
                    sampleSize: 16,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            };

            this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            this._setStatus("Microphone permissions granted");
            this._setDebug(`Microphone stream acquired: ${this.mediaStream.getAudioTracks().length} audio tracks`);
            
            return true;
        } catch (error) {
            this._setError(`Failed to get microphone permissions: ${error.message}`);
            return false;
        }
    }

    /**
     * Initialize audio context and processing nodes
     */
    async initializeAudioProcessing() {
        try {
            if (!this.mediaStream) {
                throw new Error("No media stream available. Call requestPermissions() first.");
            }

            // Create audio context - let it use native sample rate
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.nativeSampleRate = this.audioContext.sampleRate;

            // Calculate resampling ratio
            this.resampleRatio = this.sampleRate / this.nativeSampleRate;

            // Create source node from microphone stream
            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

            // Create processor node for audio processing
            this.processorNode = this.audioContext.createScriptProcessor(this.bufferSize, this.channels, this.channels);
            this.processorNode.onaudioprocess = this._processAudioData.bind(this);

            // Connect nodes
            this.sourceNode.connect(this.processorNode);
            this.processorNode.connect(this.audioContext.destination);

            this._setStatus("Audio processing initialized");
            this._setDebug(`Audio context: ${this.audioContext.sampleRate}Hz, ${this.channels} channels`);
            
            return true;
        } catch (error) {
            this._setError(`Failed to initialize audio processing: ${error.message}`);
            return false;
        }
    }

    /**
     * Set up message listener for WebSocket status messages
     */
    setupWebSocketListener() {
        // Listen for microphone status messages from server
        if (typeof webrtc !== 'undefined' && webrtc.dataWS) {
            const originalOnMessage = webrtc.dataWS.onmessage;
            webrtc.dataWS.onmessage = (event) => {
                if (typeof event.data === 'string' && event.data.startsWith('MIC_STATUS:')) {
                    const status = event.data.substring(11);
                    switch(status) {
                        case 'disabled_by_server':
                            this._setError("Microphone is disabled by server settings");
                            this.disable();
                            break;
                        case 'pulseaudio_unavailable':
                            this._setError("PulseAudio not available on server");
                            this.disable();
                            break;
                        case 'ready':
                            this._setStatus("Server microphone support ready");
                            break;
                        default:
                            this._setDebug(`Server microphone status: ${status}`);
                    }
                }
                // Call original handler
                if (originalOnMessage) {
                    originalOnMessage(event);
                }
            };
        }
    }

    /**
     * Process audio data from microphone
     * Implements silence detection, resampling, and 16-bit integer encoding
     */
    _processAudioData(audioProcessingEvent) {
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const inputData = inputBuffer.getChannelData(0); // Get mono channel

        // Resample if needed (from native rate to 24kHz)
        let resampledData;
        if (Math.abs(this.resampleRatio - 1) > 0.01) {
            // Simple linear interpolation resampling
            const outputLength = Math.floor(inputData.length * this.resampleRatio);
            resampledData = new Float32Array(outputLength);

            for (let i = 0; i < outputLength; i++) {
                const srcIndex = i / this.resampleRatio;
                const srcIndexInt = Math.floor(srcIndex);
                const srcIndexFrac = srcIndex - srcIndexInt;

                if (srcIndexInt < inputData.length - 1) {
                    // Linear interpolation between samples
                    resampledData[i] = inputData[srcIndexInt] * (1 - srcIndexFrac) +
                                      inputData[srcIndexInt + 1] * srcIndexFrac;
                } else {
                    resampledData[i] = inputData[Math.min(srcIndexInt, inputData.length - 1)];
                }
            }
        } else {
            resampledData = inputData;
        }

        // Convert float32 to signed 16-bit integers
        const int16Array = new Int16Array(resampledData.length);
        let hasAudio = false;

        for (let i = 0; i < resampledData.length; i++) {
            // Convert float32 (-1.0 to 1.0) to int16 (-32768 to 32767)
            const sample = Math.max(-1, Math.min(1, resampledData[i]));
            int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;

            // Check for silence (all zeros or below threshold)
            if (Math.abs(sample) > this.silenceThreshold) {
                hasAudio = true;
            }
        }

        // Skip transmission if all zeros (silence detection)
        if (!hasAudio) {
            return;
        }

        // Buffer audio data for packet transmission
        this.audioBuffer.push(int16Array);
        
        // Check if we have enough data for a packet (10ms worth)
        const samplesPerPacket = (this.sampleRate * this.packetDuration) / 1000;
        const totalSamples = this.audioBuffer.reduce((sum, buffer) => sum + buffer.length, 0);
        
        if (totalSamples >= samplesPerPacket) {
            this._transmitAudioPacket();
        }
    }

    /**
     * Transmit audio packet via WebSocket as binary data
     * Sends raw PCM data that server expects
     */
    _transmitAudioPacket() {
        if (!this.isTransmitting) {
            return;
        }

        // Check if WebSocket is available and open
        if (!this.dataWebSocket || this.dataWebSocket.readyState !== WebSocket.OPEN) {
            // Try to get the WebSocket from the global webrtc object
            if (typeof webrtc !== 'undefined' && webrtc.dataWS) {
                this.dataWebSocket = webrtc.dataWS;
            } else {
                return;
            }
        }

        try {
            // Combine buffered audio data
            const totalSamples = this.audioBuffer.reduce((sum, buffer) => sum + buffer.length, 0);
            const combinedBuffer = new Int16Array(totalSamples);

            let offset = 0;
            for (const buffer of this.audioBuffer) {
                combinedBuffer.set(buffer, offset);
                offset += buffer.length;
            }

            // Create binary message with type 0x02 for microphone data
            const messageType = 0x02;
            const pcmData = new Uint8Array(combinedBuffer.buffer);
            const message = new Uint8Array(1 + pcmData.length);

            message[0] = messageType;
            message.set(pcmData, 1);

            // Send as binary data through WebSocket
            this.dataWebSocket.send(message);
            this._setDebug(`Transmitted microphone packet: ${combinedBuffer.length} samples`);

            // Clear buffer
            this.audioBuffer = [];

        } catch (error) {
            this._setError(`Failed to transmit audio packet: ${error.message}`);
        }
    }

    /**
     * Handle incoming data channel messages
     */
    _handleDataChannelMessage(event) {
        try {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
                case 'microphone_control':
                    this._handleMicrophoneControl(message.data);
                    break;
                case 'microphone_status':
                    this._setStatus(`Server: ${message.data.status}`);
                    break;
                default:
                    this._setDebug(`Unknown microphone message: ${message.type}`);
            }
        } catch (error) {
            this._setError(`Failed to parse microphone data channel message: ${error.message}`);
        }
    }

    /**
     * Handle microphone control messages from server
     */
    _handleMicrophoneControl(data) {
        switch (data.action) {
            case 'start':
                this.startTransmission();
                break;
            case 'stop':
                this.stopTransmission();
                break;
            case 'mute':
                this.mute();
                break;
            case 'unmute':
                this.unmute();
                break;
            default:
                this._setDebug(`Unknown microphone control action: ${data.action}`);
        }
    }

    /**
     * Start microphone transmission
     */
    async startTransmission() {
        try {
            if (!this.mediaStream) {
                const hasPermissions = await this.requestPermissions();
                if (!hasPermissions) return false;
            }

            if (!this.audioContext) {
                const initialized = await this.initializeAudioProcessing();
                if (!initialized) return false;
            }

            if (!this.peerConnection) {
                const connected = await this.setupWebRTCConnection();
                if (!connected) return false;
            }

            this.isTransmitting = true;
            this._setStatus("Microphone transmission started");
            this._setDebug("Audio processing and transmission active");
            
            return true;
        } catch (error) {
            this._setError(`Failed to start microphone transmission: ${error.message}`);
            return false;
        }
    }

    /**
     * Stop microphone transmission
     */
    stopTransmission() {
        this.isTransmitting = false;
        this._setStatus("Microphone transmission stopped");
    }

    /**
     * Mute microphone (stop processing but keep connection)
     */
    mute() {
        if (this.mediaStream) {
            this.mediaStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
        }
        this._setStatus("Microphone muted");
    }

    /**
     * Unmute microphone
     */
    unmute() {
        if (this.mediaStream) {
            this.mediaStream.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
        }
        this._setStatus("Microphone unmuted");
    }

    /**
     * Enable microphone functionality
     */
    async enable() {
        this.isEnabled = true;
        this.setupWebSocketListener();
        return await this.startTransmission();
    }

    /**
     * Disable and cleanup microphone functionality
     */
    disable() {
        this.isEnabled = false;
        this.stopTransmission();
        
        // Cleanup resources
        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode = null;
        }
        
        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
        
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        
        this._setStatus("Microphone disabled and cleaned up");
    }

    /**
     * Check if microphone is supported
     */
    static isSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    /**
     * Get available audio input devices
     */
    static async getAudioInputDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(device => device.kind === 'audioinput');
        } catch (error) {
            console.error('Failed to enumerate audio devices:', error);
            return [];
        }
    }

    // Status and debug methods
    _setStatus(message) {
        if (this.onstatuschange) {
            this.onstatuschange(`[Microphone] ${message}`);
        }
    }

    _setDebug(message) {
        if (this.ondebug) {
            this.ondebug(`[Microphone] ${message}`);
        }
    }

    _setError(message) {
        if (this.onerror) {
            this.onerror(`[Microphone] ${message}`);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MicrophoneManager;
}