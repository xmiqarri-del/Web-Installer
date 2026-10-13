// ==============================
// إعدادات الـ USB الأساسية (عدّلها حسب جهازك)
// ==============================
const INTERFACE_NUMBER = 0;   // رقم الواجهة (Interface)
const ENDPOINT_IN = 1;        // نقطة الاستقبال (Read)
const ENDPOINT_OUT = 2;       // نقطة الإرسال (Write)
const READ_PACKET_SIZE = 64;  
const LOCAL_ECHO = true;      

// ==============================
// فئة معالجة أخطاء الذكاء الاصطناعي
// ==============================
class AiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiResponseError";
  }
}

// ==============================
// حالة التطبيق
// ==============================
let device = null;
let connecting = false;
let commandLine = '';
let abortController = new AbortController();
let fileStreamWriter = null;
let lastTerminalOutput = ''; 

// متغيرات تحسين الأداء (Buffering)
let termBuffer = '';
let renderAnimationFrame = null;
let renderTimeout = null;
const MAX_BUFFER_SIZE = 8192; 

const encoder = new TextEncoder();
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const logBtn = document.getElementById('log-btn');
const logCloseBtn = document.getElementById('log-close-btn');
const aiBtn = document.getElementById('ai-btn');

// ==============================
// 1. تهيئة Xterm.js
// ==============================
const term = new Terminal({
  cursorBlink: true,
  theme: { background: '#1e1e1e', foreground: '#00ff00', cursor: '#ffaa00' }
});

term.open(document.getElementById('terminal-container'));
term.writeln('\x1b[1;36m[نظام V8 المتكامل]: جاهز للتشغيل والتواصل مع الأجهزة.\x1b[0m');
term.writeln('------------------------------------------------------\r\n');

function isConnected() { return device !== null && device.opened; }
function printError(msg) { term.writeln(`\x1b[31m${msg}\x1b[0m\r\n`); }
function printInfo(msg) { term.writeln(`\x1b[33m${msg}\x1b[0m\r\n`); }

// ==============================
// 2. دالة تفريغ المجمع (Buffer Flush) 
// ==============================
function queueTerminalRender(chunk) {
  termBuffer += chunk;
  
  const flush = () => {
    if (termBuffer) {
      term.write(termBuffer);
      termBuffer = '';
    }
    if (renderAnimationFrame) { cancelAnimationFrame(renderAnimationFrame); renderAnimationFrame = null; }
    if (renderTimeout) { clearTimeout(renderTimeout); renderTimeout = null; }
  };

  if (termBuffer.length > MAX_BUFFER_SIZE) {
    flush();
    return;
  }

  if (!renderAnimationFrame && !renderTimeout) {
    renderAnimationFrame = requestAnimationFrame(flush);
    renderTimeout = setTimeout(flush, 50); 
  }
}

// ==============================
// إدخال المستخدم
// ==============================
term.onData(data => {
  if (data.startsWith('\x1b')) return;
  if (!isConnected()) return;

  for (const ch of data) {
    if (ch === '\r') {
      term.write('\r\n');
      sendUsbCommand(commandLine);
      commandLine = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (commandLine.length > 0) {
        commandLine = commandLine.slice(0, -1);
        if (LOCAL_ECHO) term.write('\b \b');
      }
    } else if (ch === '\x03') {
      commandLine = '';
      term.write('^C\r\n');
      sendRaw('\x03');
    } else if (ch >= ' ') {
      commandLine += ch;
      if (LOCAL_ECHO) term.write(ch);
    }
  }
});

// ==============================
// 3. الاتصال باستخدام Web Streams API
// ==============================
connectBtn.addEventListener('click', async () => {
  if (connecting) return;
  connecting = true;
  updateButtons();

  try {
    const newDevice = await navigator.usb.requestDevice({ filters: [] });
    await closeDevice();
    device = newDevice;

    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(INTERFACE_NUMBER);
    
    printInfo(`[نجاح]: تم الاتصال بجهاز ${device.productName}`);
    
    abortController = new AbortController();
    startUsbStreamPipeline();
  } catch (error) {
    if (error.name !== 'NotFoundError') printError(`[خطأ]: ${error.message}`);
  } finally {
    connecting = false;
    updateButtons();
  }
});

disconnectBtn.addEventListener('click', async () => {
  await closeDevice();
  printInfo('[تم]: تم فصل الجهاز بواسطة المستخدم');
});

async function closeDevice() {
  abortController.abort(); 
  await closeLogFile();
  
  if (device && device.opened) {
    try { await device.releaseInterface(INTERFACE_NUMBER); } catch (_) {}
    try { await device.close(); } catch (_) {}
  }
  device = null;
  updateButtons();
}

async function closeLogFile() {
  if (fileStreamWriter) {
    try { await fileStreamWriter.close(); printInfo('[ملف السجل]: تم حفظ وإغلاق الملف بنجاح.'); } 
    catch (_) {}
    fileStreamWriter = null;
  }
}

function updateButtons() {
  const connected = isConnected();
  connectBtn.disabled = connecting;
  disconnectBtn.disabled = connecting || !connected;
  logBtn.disabled = !connected || fileStreamWriter !== null;
  logCloseBtn.style.display = fileStreamWriter !== null ? 'inline-block' : 'none';
  aiBtn.disabled = !connected;
}

// ==============================
// 4. بناء قناة التدفق 
// ==============================
function createUsbReadableStream(signal) {
  let isReading = true;
  signal.addEventListener('abort', () => isReading = false);
  
  return new ReadableStream({
    async pull(controller) {
      if (!isReading) { controller.close(); return; }
      try {
        const result = await device.transferIn(ENDPOINT_IN, READ_PACKET_SIZE);
        
        if (result.status === 'stall') {
          await device.clearHalt('in', ENDPOINT_IN);
          return;
        }
        
        if (result.data && result.data.byteLength > 0) {
          controller.enqueue(result.data);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { isReading = false; }
  });
}

async function startUsbStreamPipeline() {
  try {
    const usbStream = createUsbReadableStream(abortController.signal);
    const decoderStream = new TextDecoderStream('utf-8');
    
    await usbStream.pipeThrough(decoderStream).pipeTo(new WritableStream({
      async write(chunk) {
        queueTerminalRender(chunk);
        
        lastTerminalOutput += chunk;
        if (lastTerminalOutput.length > 1500) {
          lastTerminalOutput = lastTerminalOutput.slice(-1500);
        }

        if (fileStreamWriter) {
          try {
            await fileStreamWriter.write(chunk);
          } catch (fsError) {
            printError(`\r\n[خطأ تخزين القرص]: ${fsError.message}. تم إيقاف التسجيل للحفاظ على جلسة الـ USB.`);
            await closeLogFile();
            updateButtons();
          }
        }
      }
    }), { signal: abortController.signal });
    
  } catch (error) {
    if (error.name !== 'AbortError') {
      if (device !== null) {
        printError(`\r\n[انقطع الاتصال]: ${error.message}`);
      }
      await closeDevice();
    }
  }
}

async function sendRaw(text) {
  if (!isConnected()) return;
  try {
    await device.transferOut(ENDPOINT_OUT, encoder.encode(text));
  } catch (error) {
    printError(`[فشل الإرسال]: ${error.message}`);
  }
}

async function sendUsbCommand(cmd) {
  await sendRaw(cmd + '\r\n');
}

// ==============================
// 5. حفظ البيانات الحية وإغلاق الملف
// ==============================
logBtn.addEventListener('click', async () => {
  try {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName: `usb_session_${new Date().toISOString().split('T')[0]}.log`,
      types: [{ accept: { 'text/plain': ['.log', '.txt'] } }]
    });
    fileStreamWriter = await fileHandle.createWritable();
    printInfo(`[نظام الملفات]: تم تفعيل التسجيل المباشر. لن يكتمل الحفظ إلا عند "إنهاء الحفظ" أو "فصل الجهاز".`);
    updateButtons();
  } catch (error) {
    if (error.name !== 'AbortError') printError(`[فشل إنشاء الملف]: ${error.message}`);
  }
});

logCloseBtn.addEventListener('click', async () => {
  await closeLogFile();
  updateButtons();
});

// ==============================
// 6. التحليل المحلي بالذكاء الاصطناعي 
// ==============================
aiBtn.addEventListener('click', async () => {
  if (lastTerminalOutput.trim() === '') {
    printInfo('[الذكاء الاصطناعي]: لا توجد بيانات كافية للتحليل.');
    return;
  }
  
  aiBtn.disabled = true;
  const originalText = aiBtn.innerHTML;
  aiBtn.innerHTML = '⏳ جاري التحليل...';
  term.writeln('\x1b[1;35m\r\n[جاري تحليل السجلات الأخيرة عبر المحرك المحلي...]\x1b[0m');
  
  const fetchController = new AbortController();
  const timeoutId = setTimeout(() => fetchController.abort(), 15000);
  
  try {
    const response = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "local-model", 
        messages: [
          { role: 'system', content: 'أنت مهندس تقني خبير. قم بتحليل مخرجات جهاز الـ USB التالية، واكتشف الأخطاء إن وجدت بشكل مختصر جداً.' },
          { role: 'user', content: `المخرجات الأخيرة: \n${lastTerminalOutput}` }
        ],
        temperature: 0.3
      }),
      signal: fetchController.signal
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new AiResponseError(`HTTP ${response.status}: ${errText}`);
    }
    
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AiResponseError('الرد ليس بتنسيق JSON صالح من الخادم.');
    }
    
    const aiContent = data?.choices?.[0]?.message?.content;
    if (!aiContent) {
        throw new AiResponseError('شكل الرد الوارد من الخادم غير متوقع (تأكد من توافق واجهة الخادم).');
    }
    
    term.writeln(`\x1b[1;36m\r\n🤖 [التحليل]: ${aiContent}\x1b[0m\r\n`);
    
  } catch (error) {
    if (error.name === 'AbortError') {
      printError('\r\n[فشل التحليل]: انتهت المهلة الزمنية (Timeout). المحرك المحلي لا يستجيب.');
    } else if (error instanceof AiResponseError) {
      printError(`\r\n[خطأ في الاستجابة]: ${error.message}`);
    } else {
      printError(`\r\n[فشل الاتصال بالخادم]: تأكد من تشغيل LM Studio على المنفذ 1234، ومن تفعيل "CORS".`);
    }
  } finally {
    clearTimeout(timeoutId);
    aiBtn.innerHTML = originalText;
    updateButtons(); 
  }
});

navigator.usb.addEventListener('disconnect', async event => {
  if (device && event.device === device) {
    printError(`[تنبيه]: تم فصل الجهاز ${event.device.productName}`);
    await closeDevice();
  }
});
