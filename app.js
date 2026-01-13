/**
 * Groq Whisper Meeting Transcriber
 * Powered by Groq API (Whisper v3 + Llama 3)
 * Supports: Microphone, System Audio, or Both (separate channels)
 */

class App {
    constructor() {
        this.config = {
            apiKey: localStorage.getItem('groq_api_key') || '',
            transcriptionModel: localStorage.getItem('groq_stt_model') || 'whisper-large-v3',
            chatModel: 'openai/gpt-oss-120b',
            chunkInterval: parseInt(localStorage.getItem('chunk_interval')) || 10,
        };

        this.state = {
            isRecording: false,
            audioMode: 'mic', // 'mic', 'system', 'both'
            startTime: null,
            timerId: null,
            
            // Single mode recorder
            mediaRecorder: null,
            audioChunks: [],
            
            // Dual mode recorders (for 'both')
            micRecorder: null,
            systemRecorder: null,
            micChunks: [],
            systemChunks: [],
            
            // Transcripts
            transcripts: [], // { text, time, source: 'mic'|'system'|'combined' }
            micTranscripts: [],
            systemTranscripts: [],
            
            // Streams and contexts
            streamsToCleanup: [],
            audioContext: null,
            
            // VAD State
            vadIntervalId: null,
            hasSpeechInChunk: false, // For single mode
            hasSpeechInMicChunk: false, // For dual mode mic
            hasSpeechInSystemChunk: false, // For dual mode system
        };

        this.dom = {};
        this.initDOM();
        this.initEvents();
        this.initTheme();

        if (!this.config.apiKey) {
            this.showModal();
        }
    }

    initDOM() {
        // Main controls
        this.dom.recordBtn = document.getElementById('recordBtn');
        this.dom.generateAiBtn = document.getElementById('generateAiBtn');
        this.dom.statusIndicator = document.getElementById('statusIndicator');
        this.dom.statusText = this.dom.statusIndicator.querySelector('.status-text');
        this.dom.statusDot = this.dom.statusIndicator.querySelector('.status-dot');
        this.dom.timer = document.getElementById('recordingTimer');
        this.dom.downloadBtn = document.getElementById('downloadBtn');
        this.dom.themeBtn = document.getElementById('themeBtn');
        
        // Transcript containers
        this.dom.singleTranscriptArea = document.getElementById('singleTranscriptArea');
        this.dom.dualTranscriptArea = document.getElementById('dualTranscriptArea');
        this.dom.transcriptContainer = document.getElementById('transcriptContainer');
        this.dom.micTranscriptContainer = document.getElementById('micTranscriptContainer');
        this.dom.systemTranscriptContainer = document.getElementById('systemTranscriptContainer');
        
        // Settings
        this.dom.modal = document.getElementById('settingsModal');
        this.dom.settingsBtn = document.getElementById('settingsBtn');
        this.dom.saveSettingsBtn = document.getElementById('saveSettingsBtn');
        this.dom.apiKeyInput = document.getElementById('apiKeyInput');
        this.dom.chunkInput = document.getElementById('chunkInterval');
        this.dom.chunkValue = document.getElementById('chunkValue');
        this.dom.transcriptionModelSelect = document.getElementById('transcriptionModelSelect');
        this.dom.aiModelSelect = document.getElementById('aiModelSelect');

        // Layout Columns (for mobile tabs)
        this.dom.transcriptColumn = document.querySelector('.transcript-column');
        this.dom.aiColumn = document.querySelector('.ai-column');
        this.dom.mobileTabs = document.querySelectorAll('.mobile-tab');

        // Outputs
        this.dom.summaryContent = document.getElementById('summaryContent');
        this.dom.actionItemList = document.getElementById('actionItemList');
        
        // Init values
        this.dom.apiKeyInput.value = this.config.apiKey;
        this.dom.chunkInput.value = this.config.chunkInterval;
        this.dom.chunkValue.textContent = `${this.config.chunkInterval}秒`;
        this.dom.transcriptionModelSelect.value = this.config.transcriptionModel;
    }

    initEvents() {
        this.dom.recordBtn.onclick = () => this.toggleRecording();

        this.dom.settingsBtn.onclick = () => this.showModal();
        this.dom.downloadBtn.onclick = () => this.exportData();
        this.dom.themeBtn.onclick = () => this.toggleTheme();
        
        this.dom.modal.querySelector('.close-modal').onclick = () => this.hideModal();
        this.dom.modal.querySelector('.back-modal-btn').onclick = () => this.hideModal();
        this.dom.saveSettingsBtn.onclick = () => this.saveSettings();
        
        this.dom.chunkInput.oninput = (e) => {
            this.dom.chunkValue.textContent = `${e.target.value}秒`;
        };
        
        this.dom.generateAiBtn.onclick = () => this.generateSummary();
        
        document.getElementById('copyBtn').onclick = () => this.copyTranscript();
        document.getElementById('clearBtn').onclick = () => this.clearAll();
        
        // Audio source selection - update UI when changed
        document.querySelectorAll('input[name="audioSource"]').forEach(radio => {
            radio.onchange = () => this.updateLayoutForMode(radio.value);
        });

        // Mobile Tab Switching
        this.dom.mobileTabs.forEach(tab => {
            tab.onclick = () => this.switchMobileTab(tab.dataset.target);
        });
        
        // Initial Mobile State
        if (window.innerWidth <= 768) {
            this.switchMobileTab('transcript');
        }
    }

    // ==========================================
    // Layout Management
    // ==========================================

    // ==========================================
    // Layout Management
    // ==========================================

    switchMobileTab(target) {
        // Update Tab Styles
        this.dom.mobileTabs.forEach(tab => {
            if(tab.dataset.target === target) tab.classList.add('active');
            else tab.classList.remove('active');
        });

        // Show/Hide Columns
        if (target === 'transcript') {
            this.dom.transcriptColumn.classList.add('active-tab-view');
            this.dom.aiColumn.classList.remove('active-tab-view');
        } else {
            this.dom.transcriptColumn.classList.remove('active-tab-view');
            this.dom.aiColumn.classList.add('active-tab-view');
        }
    }

    updateLayoutForMode(mode) {
        if (mode === 'both') {
            this.dom.singleTranscriptArea.style.display = 'none';
            this.dom.dualTranscriptArea.style.display = 'flex';
        } else {
            this.dom.singleTranscriptArea.style.display = 'flex';
            this.dom.dualTranscriptArea.style.display = 'none';
        }
    }

    // ==========================================
    // VAD Logic (Voice Activity Detection) - REMOVED
    // ==========================================
    // VAD caused issues with recording start/stop. 
    // Reverted to always recording, relying on text filtering for hallucinations.

    // ==========================================
    // Recording Logic
    // ==========================================

    async toggleRecording() {
        if (!this.state.isRecording) {
            await this.startRecording();
        } else {
            this.stopRecording();
        }
    }

    async startRecording() {
        if (!this.config.apiKey) {
            alert('Groq APIキーを設定してください');
            this.showModal();
            return;
        }

        const audioSource = document.querySelector('input[name="audioSource"]:checked')?.value || 'mic';
        this.state.audioMode = audioSource;
        this.updateLayoutForMode(audioSource);
        
        try {
            if (audioSource === 'both') {
                await this.startDualRecording();
            } else {
                await this.startSingleRecording(audioSource);
            }
        } catch (err) {
            console.error('Audio Error:', err);
            alert('音声の取得に失敗しました: ' + err.message);
        }
    }

    async startSingleRecording(source) {
        let stream;
        this.state.streamsToCleanup = [];
        
        if (source === 'mic') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.state.streamsToCleanup.push(stream);
        } else if (source === 'system') {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length === 0) {
                displayStream.getTracks().forEach(t => t.stop());
                throw new Error('システムオーディオが取得できませんでした。画面共有時に「システムオーディオを共有」にチェックを入れてください。');
            }
            
            displayStream.getVideoTracks().forEach(t => t.stop());
            stream = new MediaStream(audioTracks);
            this.state.streamsToCleanup.push(displayStream);
        }

        // Setup recorder
        const mimeType = this.getMimeType();
        this.state.mediaRecorder = new MediaRecorder(stream, { mimeType });
        this.state.audioChunks = [];
        this.state.isRecording = true;
        this.state.startTime = Date.now();
        
        this.updateUI(true);
        this.startTimer();

        this.state.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.state.audioChunks.push(e.data);
        };

        const intervalMs = this.config.chunkInterval * 1000;
        this.state.chunkIntervalId = setInterval(() => {
            if (this.state.isRecording && this.state.mediaRecorder?.state === 'recording') {
                this.state.mediaRecorder.stop();
            }
        }, intervalMs);

        this.state.mediaRecorder.onstop = async () => {
            const blob = new Blob(this.state.audioChunks, { type: mimeType });
            this.state.audioChunks = [];
            
            if (blob.size > 0) {
                this.processAudioChunk(blob, 'combined');
            }
            
            if (this.state.isRecording) {
                this.state.mediaRecorder.start();
            } else {
                this.cleanupStreams();
            }
        };

        this.state.mediaRecorder.start();
    }

    async startDualRecording() {
        this.state.streamsToCleanup = [];
        
        // Get microphone
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.state.streamsToCleanup.push(micStream);
        
        // Get system audio
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        this.state.streamsToCleanup.push(displayStream);
        
        const systemAudioTracks = displayStream.getAudioTracks();
        if (systemAudioTracks.length === 0) {
            this.cleanupStreams();
            throw new Error('システムオーディオが取得できませんでした。画面共有時に「システムオーディオを共有」にチェックを入れてください。');
        }
        
        displayStream.getVideoTracks().forEach(t => t.stop());
        const systemStream = new MediaStream(systemAudioTracks);
        
        // Setup MIME type
        const mimeType = this.getMimeType();
        
        // Setup mic recorder
        this.state.micRecorder = new MediaRecorder(micStream, { mimeType });
        this.state.micChunks = [];
        
        // Setup system recorder
        this.state.systemRecorder = new MediaRecorder(systemStream, { mimeType });
        this.state.systemChunks = [];
        
        this.state.isRecording = true;
        this.state.startTime = Date.now();
        
        this.updateUI(true);
        this.startTimer();

        // Mic recorder handlers
        this.state.micRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.state.micChunks.push(e.data);
        };
        
        this.state.micRecorder.onstop = async () => {
            const blob = new Blob(this.state.micChunks, { type: mimeType });
            this.state.micChunks = [];
            
            if (blob.size > 0) {
                this.processAudioChunk(blob, 'mic');
            }
            
            if (this.state.isRecording) {
                this.state.micRecorder.start();
            }
        };

        // System recorder handlers
        this.state.systemRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.state.systemChunks.push(e.data);
        };
        
        this.state.systemRecorder.onstop = async () => {
            const blob = new Blob(this.state.systemChunks, { type: mimeType });
            this.state.systemChunks = [];
            
            if (blob.size > 0) {
                this.processAudioChunk(blob, 'system');
            }
            
            if (this.state.isRecording) {
                this.state.systemRecorder.start();
            } else {
                this.cleanupStreams();
            }
        };

        // Start interval for chunking
        const intervalMs = this.config.chunkInterval * 1000;
        this.state.chunkIntervalId = setInterval(() => {
            if (!this.state.isRecording) return;
            
            if (this.state.micRecorder?.state === 'recording') {
                this.state.micRecorder.stop();
            }
            if (this.state.systemRecorder?.state === 'recording') {
                this.state.systemRecorder.stop();
            }
        }, intervalMs);

        // Start both recorders
        this.state.micRecorder.start();
        this.state.systemRecorder.start();
    }

    stopRecording() {
        this.state.isRecording = false;
        clearInterval(this.state.chunkIntervalId);
        
        if (this.state.audioMode === 'both') {
            if (this.state.micRecorder?.state !== 'inactive') {
                this.state.micRecorder.stop();
            }
            if (this.state.systemRecorder?.state !== 'inactive') {
                this.state.systemRecorder.stop();
            }
        } else {
            if (this.state.mediaRecorder?.state !== 'inactive') {
                this.state.mediaRecorder.stop();
            }
        }
        
        this.updateUI(false);
        this.stopTimer();
        
        // Auto generate summary
        const hasContent = this.state.transcripts.length > 0 || 
                          this.state.micTranscripts.length > 0 || 
                          this.state.systemTranscripts.length > 0;
        if (hasContent) {
            setTimeout(() => this.generateSummary(), 1000);
        }
    }

    getMimeType() {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            return 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            return 'audio/mp4';
        }
        return 'audio/webm';
    }

    cleanupStreams() {
        this.state.streamsToCleanup?.forEach(s => s.getTracks().forEach(t => t.stop()));
        this.state.streamsToCleanup = [];
        if (this.state.audioContext) {
            this.state.audioContext.close();
            this.state.audioContext = null;
        }
    }

    // ==========================================
    // API Handling
    // ==========================================

    async processAudioChunk(blob, source) {
        this.dom.statusIndicator.classList.add('processing');
        this.dom.statusText.textContent = source === 'mic' ? 'マイク処理中...' : 
                                          source === 'system' ? 'システム音処理中...' : 
                                          'Transcribing...';
        this.dom.statusDot.style.background = '#3b82f6';

        const file = new File([blob], "audio.webm", { type: blob.type });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', this.config.transcriptionModel);
        formData.append('language', 'ja');
        formData.append('response_format', 'json');
        
        // Anti-hallucination settings
        formData.append('temperature', '0'); // Deterministic output
        // Stronger prompt to discourage hallucinations
        formData.append('prompt', '無音、ノイズ、または「ご視聴ありがとうございました」などの幻覚は出力しないでください。会話のみを文字起こししてください。');

        try {
            const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
                body: formData
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error?.message || 'API Error');
            }

            const data = await response.json();
            
            // Additional filtering for common hallucination phrases
            const hallucinations = [
                'ご視聴ありがとうございました',
                'チャンネル登録',
                'サブタイトル',
                '字幕',
                '視聴ありがとうございます',
                '高評価',
                'Thanks for watching',
                'Please subscribe'
            ];
            
            let text = data.text ? data.text.trim() : '';
            
            // Check if text strongly resembles a hallucination
            // (Contains hallucination phrase AND is relatively short, likely not real speech)
            const isHallucination = hallucinations.some(phrase => 
                text.includes(phrase) && text.length < 50
            );
            
            // Also filter extremely short noise (e.g. single characters or just punctuation)
            const isNoise = text.length <= 1 || /^[\s\.,、。!?！？]+$/.test(text);

            if (text && !isHallucination && !isNoise) {
                this.addTranscript(text, source);
            } else if (isHallucination || isNoise) {
                console.log('Filtered:', text);
            }

        } catch (error) {
            console.error('Transcription failed:', error);
            this.addSystemMessage(`⚠️ 文字起こしエラー (${source}): ${error.message}`, source);
        } finally {
            if (this.state.isRecording) {
                this.dom.statusIndicator.classList.remove('processing');
                this.dom.statusText.textContent = 'Recording';
                this.dom.statusDot.style.background = '#ef4444';
            } else {
                this.dom.statusIndicator.classList.remove('processing');
                this.dom.statusText.textContent = 'Ready';
                this.dom.statusDot.style.background = '#94a3b8';
            }
        }
    }

    async generateSummary() {
        // Compile all transcripts
        let fullText = '';
        
        if (this.state.audioMode === 'both') {
            const systemText = this.state.systemTranscripts.map(t => `[相手 ${t.time}] ${t.text}`).join('\n');
            const micText = this.state.micTranscripts.map(t => `[自分 ${t.time}] ${t.text}`).join('\n');
            fullText = `## 相手（システム音）\n${systemText}\n\n## 自分（マイク）\n${micText}`;
        } else {
            fullText = this.state.transcripts.map(t => `[${t.time}] ${t.text}`).join('\n');
        }
        
        if (!fullText.trim()) return;
        
        this.dom.generateAiBtn.disabled = true;
        this.dom.generateAiBtn.textContent = '⏳ 分析中...';

        const model = this.dom.aiModelSelect.value || this.config.chatModel;

        // Different prompts for dual mode vs single mode
        let prompt;
        
        if (this.state.audioMode === 'both') {
            prompt = `
あなたは会議の分析アシスタントです。以下は「相手」と「自分」の会話の文字起こしです。

# 分析の観点
1. **会話の流れ**: 相手が何を説明・提案し、自分がどう応答したかを把握する
2. **要約**: 相手の主張と自分の応答を踏まえた会話全体の要点を箇条書きで整理
3. **自分のアクションアイテム**: 以下を特に抽出する
   - 相手に確認・質問すべき点（曖昧だった点、理解が不十分な点）
   - 自分が約束した・やるべきタスク
   - 次回までに準備すべきこと
   - フォローアップが必要な事項

# 出力形式 (JSON)
{
  "summary": ["要点1（常体）", "要点2（常体）", "要点3（常体）"],
  "action_items": [
    "【質問】相手に確認すべき点",
    "【タスク】自分がやるべきこと",
    "【確認】次回確認すべき事項"
  ]
}

# アクションアイテムのルール
- 各項目の先頭に【質問】【タスク】【確認】【フォロー】などのタグを付ける
- 相手の発言で曖昧だった点や、自分が理解できていなさそうな点は「質問」として抽出
- 具体的で実行可能な形で記述する

# 文字起こし
${fullText}
`;
        } else {
            prompt = `
以下の会議の文字起こしテキストから、要点とアクションアイテムを抽出してください。
要約は箇条書きで要点を簡潔にまとめてください。

# 出力形式 (JSON)
{
  "summary": ["要点1（常体）", "要点2（常体）", "要点3（常体）"],
  "action_items": ["タスク1", "タスク2"]
}

# 文字起こし
${fullText}
`;
        }

        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    messages: [{ role: "user", content: prompt }],
                    model: model,
                    response_format: { type: "json_object" }
                })
            });

            const data = await response.json();
            const content = JSON.parse(data.choices[0].message.content);

            // summaryが配列の場合は箇条書き、文字列の場合はそのまま表示
            if (Array.isArray(content.summary)) {
                this.dom.summaryContent.innerHTML = `<ul>${content.summary.map(s => `<li>${s}</li>`).join('')}</ul>`;
            } else {
                this.dom.summaryContent.innerHTML = `<p>${content.summary}</p>`;
            }
            this.dom.summaryContent.classList.remove('placeholder');
            
            if (content.action_items && content.action_items.length > 0) {
                this.dom.actionItemList.innerHTML = content.action_items.map(i => `<li>${i}</li>`).join('');
                this.dom.actionItemList.classList.remove('placeholder');
            } else {
                this.dom.actionItemList.innerHTML = '<li>なし</li>';
            }

        } catch (error) {
            console.error('AI Error:', error);
            alert('AI分析エラー: ' + error.message);
        } finally {
            this.dom.generateAiBtn.disabled = false;
            this.dom.generateAiBtn.textContent = '✨ 分析を実行';
        }
    }

    // ==========================================
    // UI Helpers
    // ==========================================

    addTranscript(text, source) {
        const timeStr = new Date().toLocaleTimeString('ja-JP', { hour12: false });
        const entry = { text, time: timeStr, source };

        const div = document.createElement('div');
        div.className = `transcript-entry from-${source}`;
        div.innerHTML = `
            <div class="transcript-meta">[${timeStr}]</div>
            <div class="transcript-text">${text}</div>
        `;

        if (source === 'mic') {
            this.state.micTranscripts.push(entry);
            const container = this.dom.micTranscriptContainer;
            if (container.querySelector('.empty-state')) container.innerHTML = '';
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        } else if (source === 'system') {
            this.state.systemTranscripts.push(entry);
            const container = this.dom.systemTranscriptContainer;
            if (container.querySelector('.empty-state')) container.innerHTML = '';
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        } else {
            this.state.transcripts.push(entry);
            const container = this.dom.transcriptContainer;
            if (container.querySelector('.empty-state')) container.innerHTML = '';
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }
        
        this.dom.generateAiBtn.disabled = false;
    }

    addSystemMessage(msg, source) {
        const div = document.createElement('div');
        div.style.color = '#ef4444';
        div.style.fontSize = '0.8rem';
        div.style.padding = '8px 0';
        div.textContent = msg;
        
        if (source === 'mic') {
            this.dom.micTranscriptContainer.appendChild(div);
        } else if (source === 'system') {
            this.dom.systemTranscriptContainer.appendChild(div);
        } else {
            this.dom.transcriptContainer.appendChild(div);
        }
    }

    updateUI(isRecording) {
        if (isRecording) {
            this.dom.recordBtn.classList.add('recording');
            this.dom.recordBtn.querySelector('.text').textContent = '停止';
            this.dom.recordBtn.querySelector('.icon').textContent = '⏹️';
            
            this.dom.statusIndicator.classList.add('recording');
            this.dom.statusText.textContent = 'Recording';
            this.dom.statusDot.style.background = '#ef4444';
        } else {
            this.dom.recordBtn.classList.remove('recording');
            this.dom.recordBtn.querySelector('.text').textContent = '録音開始';
            this.dom.recordBtn.querySelector('.icon').textContent = '🎙️';
            
            this.dom.statusIndicator.classList.remove('recording');
            this.dom.statusText.textContent = 'Ready';
            this.dom.statusDot.style.background = '#94a3b8';
        }
    }

    startTimer() {
        this.state.timerId = setInterval(() => {
            const diff = Math.floor((Date.now() - this.state.startTime) / 1000);
            const m = Math.floor(diff / 60).toString().padStart(2, '0');
            const s = (diff % 60).toString().padStart(2, '0');
            this.dom.timer.textContent = `${m}:${s}`;
        }, 1000);
    }

    stopTimer() {
        clearInterval(this.state.timerId);
        this.dom.timer.textContent = '00:00';
    }

    // ==========================================
    // Settings
    // ==========================================

    showModal() { this.dom.modal.classList.add('active'); }
    hideModal() { this.dom.modal.classList.remove('active'); }

    // ==========================================
    // Theme
    // ==========================================

    initTheme() {
        const savedTheme = localStorage.getItem('app_theme') || 'dark';
        if (savedTheme === 'light') {
            document.documentElement.classList.add('light-theme');
            this.dom.themeBtn.textContent = '☀️';
        } else {
            document.documentElement.classList.remove('light-theme');
            this.dom.themeBtn.textContent = '🌙';
        }
    }

    toggleTheme() {
        const isLight = document.documentElement.classList.toggle('light-theme');
        if (isLight) {
            localStorage.setItem('app_theme', 'light');
            this.dom.themeBtn.textContent = '☀️';
        } else {
            localStorage.setItem('app_theme', 'dark');
            this.dom.themeBtn.textContent = '🌙';
        }
    }

    saveSettings() {
        this.config.apiKey = this.dom.apiKeyInput.value.trim();
        this.config.chunkInterval = parseInt(this.dom.chunkInput.value);
        this.config.transcriptionModel = this.dom.transcriptionModelSelect.value;
        
        localStorage.setItem('groq_api_key', this.config.apiKey);
        localStorage.setItem('chunk_interval', this.config.chunkInterval);
        localStorage.setItem('groq_stt_model', this.config.transcriptionModel);
        
        this.hideModal();
        document.getElementById('currentModelInfo').textContent = this.config.transcriptionModel.replace(/-/g, ' ');
    }

    copyTranscript() {
        let text = '';
        
        if (this.state.audioMode === 'both') {
            const systemText = this.state.systemTranscripts.map(t => `[相手 ${t.time}] ${t.text}`).join('\n');
            const micText = this.state.micTranscripts.map(t => `[自分 ${t.time}] ${t.text}`).join('\n');
            text = `## 相手（システム音）\n${systemText}\n\n## 自分（マイク）\n${micText}`;
        } else {
            text = this.state.transcripts.map(t => `[${t.time}] ${t.text}`).join('\n');
        }
        
        navigator.clipboard.writeText(text).then(() => alert('コピーしました'));
    }

    clearAll() {
        if(!confirm('全ての履歴を消去しますか？')) return;
        
        this.state.transcripts = [];
        this.state.micTranscripts = [];
        this.state.systemTranscripts = [];
        
        this.dom.transcriptContainer.innerHTML = `
            <div class="empty-state">
                <p>録音を開始すると、Groq Whisperがここに文字を起こします。</p>
                <p class="sub-text">※ 音声は数秒ごとのチャンクで送信され、解析後に表示されます。</p>
            </div>
        `;
        
        this.dom.micTranscriptContainer.innerHTML = `
            <div class="empty-state small">
                <p>あなたの音声がここに表示されます</p>
            </div>
        `;
        
        this.dom.systemTranscriptContainer.innerHTML = `
            <div class="empty-state small">
                <p>相手の音声がここに表示されます</p>
            </div>
        `;
        
        this.dom.summaryContent.innerHTML = '録音終了時、またはボタンクリックで生成されます...';
        this.dom.summaryContent.classList.add('placeholder');
        this.dom.actionItemList.innerHTML = '<li>タスクがここに抽出されます</li>';
        this.dom.actionItemList.classList.add('placeholder');
        this.dom.generateAiBtn.disabled = true;
    }

    exportData() {
        const hasData = this.state.transcripts.length > 0 || 
                       this.state.micTranscripts.length > 0 || 
                       this.state.systemTranscripts.length > 0;
        
        if (!hasData) {
            alert('データがありません');
            return;
        }

        const date = new Date().toLocaleString();
        const summary = this.dom.summaryContent.innerText;
        const actions = this.dom.actionItemList.innerText;
        
        let transcript = '';
        if (this.state.audioMode === 'both') {
            const systemText = this.state.systemTranscripts.map(t => `[相手 ${t.time}] ${t.text}`).join('\n');
            const micText = this.state.micTranscripts.map(t => `[自分 ${t.time}] ${t.text}`).join('\n');
            transcript = `## 相手（システム音）\n${systemText}\n\n## 自分（マイク）\n${micText}`;
        } else {
            transcript = this.state.transcripts.map(t => `[${t.time}] ${t.text}`).join('\n');
        }

        const content = `# 会議議事録
日時: ${date}

## 💡 要約
${summary}

## ✅ アクションアイテム
${actions}

## 📝 文字起こし
${transcript}
`;

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meeting_${new Date().toISOString().slice(0,10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Init
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
