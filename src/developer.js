// ---------- بوابة المطور: Terminal WebUSB داخل نفس الصفحة ----------
// قاعدة واحدة: جهاز واحد مفتوح في كل لحظة. عند الدخول إلى #developer يُغلق اتصال المثبّت أولاً،
// وعند الخروج يُغلق اتصال الترمينال وملف السجل. مكتبة xterm تُحمَّل عند أول فتح فقط.

const devSection = document.getElementById("developer");
const devNavLink = document.getElementById("navDeveloper");
const DEV_HASH = "#developer";
let devController = null;   // { stop } بعد بناء الترمينال
let devMounting = null;     // Promise لمنع البناء المزدوج
let devWasOpen = false;     // هل كانت بوابة المطور مفتوحة في آخر تبديل
let routeToken = 0;         // يمنع تداخل تبديلات متتالية

function loadXterm() {
  if (window.Terminal) return Promise.resolve();
  if (!document.querySelector("link[data-xterm]")) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css";
    css.dataset.xterm = "1";
    document.head.appendChild(css);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("تعذّر تحميل xterm.js من CDN. تحقق من الاتصال بالإنترنت."));
    document.head.appendChild(script);
  });
}

function buildDeveloperTerminal() {
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
const connectBtn = document.getElementById('dev-connect-btn');
const disconnectBtn = document.getElementById('dev-disconnect-btn');
const logBtn = document.getElementById('dev-log-btn');
const logCloseBtn = document.getElementById('dev-log-close-btn');
const aiBtn = document.getElementById('dev-ai-btn');

// ==============================
// 1. تهيئة Xterm.js
// ==============================
const term = new Terminal({
  cursorBlink: true,
  theme: { background: '#1e1e1e', foreground: '#00ff00', cursor: '#ffaa00' }
});

term.open(document.getElementById('dev-terminal'));
term.writeln('\x1b[1;36m[نظام V8 المتكامل]: جاهز للتشغيل والتواصل مع الأجهزة.\x1b[0m');
term.writeln('------------------------------------------------------\r\n');

// Ctrl+C مع وجود تحديد في الشاشة = نسخ، وليس إشارة إيقاف للجهاز.
// (Ctrl+Shift+C ينسخ دائماً، والإيقاف يبقى متاحاً من Ctrl+C بدون تحديد.)
term.attachCustomKeyEventHandler((e) => {
  const isCopy = e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c';
  if (!isCopy) return true;
  if (!term.hasSelection() && !e.shiftKey) return true;
  const text = term.getSelection();
  if (text) {
    navigator.clipboard?.writeText(text)
      .then(() => printInfo('[نسخ]: تم نسخ النص المحدد.'))
      .catch(() => printError('[نسخ]: تعذّر الوصول إلى الحافظة. جرّب النسخ بالزر الأيمن.'));
  }
  return false;   // لا نرسل هذا الضغط إلى الجهاز
});

let notConnectedWarned = false;

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
  if (!isConnected()) {
    if (!notConnectedWarned) {
      notConnectedWarned = true;
      printInfo('[تنبيه]: الجهاز غير متصل. اضغط "توصيل الجهاز" أولاً ثم اكتب أو الصق الأمر.');
    }
    return;
  }

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
    notConnectedWarned = false;

    printInfo(`[نجاح]: تم الاتصال بجهاز ${device.productName}`);
    dumpEndpoints();
    
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

// يعرض نقاط النهاية الموجودة فعلياً في الواجهة المحجوزة، لمعرفة القيم الصحيحة
function dumpEndpoints() {
  try {
    const iface = device.configuration.interfaces.find(i => i.interfaceNumber === INTERFACE_NUMBER);
    const alt = iface && iface.alternate;
    if (!alt) return;
    const list = alt.endpoints.map(e => `${e.direction.toUpperCase()}=${e.endpointNumber}`).join('  ');
    printInfo(`[الواجهة ${INTERFACE_NUMBER}]: نقاط النهاية المتاحة: ${list || 'لا توجد'}`);
  } catch (_) { /* تجاهل: مجرد معلومات تشخيصية */ }
}

async function sendRaw(text) {
  if (!isConnected()) return;
  try {
    await device.transferOut(ENDPOINT_OUT, encoder.encode(text));
  } catch (error) {
    printError(`[فشل الإرسال]: ${error.message}`);
    if (/claimed/i.test(error.message)) {
      printError(`[تلميح]: ENDPOINT_OUT=${ENDPOINT_OUT} غير موجود في الواجهة المحجوزة. راجع نقاط النهاية أعلاه وعدّل الثوابت في أعلى src/developer.js.`);
    }
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

  return { stop: closeDevice };
}

async function mountDeveloper() {
  if (!devMounting) {
    devMounting = loadXterm()
      .then(() => buildDeveloperTerminal())
      .catch((error) => {
        devMounting = null;
        const status = document.getElementById("dev-status");
        if (status) status.textContent = error.message;
        return null;
      });
  }
  devController = await devMounting;
}

async function applyRoute() {
  const token = ++routeToken;
  const wantDev = location.hash === DEV_HASH;

  // لا نبدّل وسط عملية تثبيت جارية في المثبّت، ونعيد المحاولة بعد قليل
  if (wantDev && busy) {
    setTimeout(applyRoute, 500);
    return;
  }

  if (!wantDev && !devWasOpen) return;     // لا تغيير مطلوب في الصفحة الرئيسية
  if (wantDev && devWasOpen && devController) return;

  if (wantDev) {
    // إغلاق اتصال المثبّت أولاً حتى يتمكن الترمينال من فتح الجهاز
    if (adb) await disconnect();
  } else if (devController) {
    await devController.stop();
  }
  if (token !== routeToken) return;

  for (const el of document.body.children) {
    if (el === devSection || el.tagName === "HEADER" || el.tagName === "SCRIPT") continue;
    el.hidden = wantDev;
  }
  devSection.hidden = !wantDev;
  devNavLink.classList.toggle("active", wantDev);
  document.querySelectorAll('.primary-nav a[href="#installer"]').forEach((a) => a.classList.toggle("active", !wantDev));
  devWasOpen = wantDev;

  if (wantDev) {
    await mountDeveloper();
    if (token !== routeToken) return;
    window.scrollTo({ top: 0 });
  }
}

window.addEventListener("hashchange", applyRoute);
applyRoute();
