import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};

// Run the component's real event handlers with a deterministic hook lifecycle.
// Media permission and recorder events stay asynchronous, as in the browser.
function createComposer(t, getUserMedia) {
  const replaceGlobal = (name, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  };
  const slots = [];
  const pendingEffects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [
        slots[index].value,
        (value) => {
          slots[index].value =
            typeof value === "function" ? value(slots[index].value) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (
        !previous ||
        dependencies.some((value, i) => value !== previous.dependencies[i])
      ) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const recorderEvents = [];
  const recorders = [];
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    stopCount = 0;
    constructor(stream) {
      this.stream = stream;
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.stopCount += 1;
      this.state = "inactive";
      recorderEvents.push(() => this.onstop?.());
    }
  }
  replaceGlobal("window", {
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  replaceGlobal("navigator", { mediaDevices: { getUserMedia } });
  replaceGlobal("MediaRecorder", Recorder);
  const jsx = (type, props) => ({ type, props });
  const compiled = ts.transpileModule(
    readFileSync(
      new URL("../src/components/VoiceComposer.tsx", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        jsxImportSource: "preact",
      },
    },
  ).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (specifier) => {
      if (specifier === "preact/hooks") return hooks;
      if (specifier === "preact/jsx-runtime") return { jsx, jsxs: jsx };
      if (specifier === "../lib/utils")
        return { cn: (...values) => values.filter(Boolean).join(" ") };
      if (specifier === "../lib/mobile")
        return {
          getMobileFileAccept: () => "image/*",
          shouldUseCapture: () => false,
        };
      if (specifier === "lucide-react")
        return { Circle: "circle", Square: "square" };
      if (specifier === "../assets/icons")
        return { AttachIcon: "attach", SendUpArrowIcon: "send" };
      if (specifier === "./ui/mic-selector")
        return { MicSelector: "mic-selector" };
      throw new Error(`Unexpected VoiceComposer import: ${specifier}`);
    },
    loaded,
    loaded.exports,
  );
  const sends = [];
  let tree;
  let props = { onSend: (...args) => sends.push(args) };
  const render = (changes = {}) => {
    props = { ...props, ...changes };
    cursor = 0;
    tree = loaded.exports.VoiceComposer(props);
    while (pendingEffects.length) pendingEffects.shift()();
  };
  const find = (node, label) => {
    if (!node) return null;
    if (Array.isArray(node))
      return node.map((child) => find(child, label)).find(Boolean);
    if (node.props?.["aria-label"] === label) return node;
    return find(node.props?.children, label);
  };
  render();
  return {
    render,
    click: (label) => {
      const control = find(tree, label);
      assert.ok(control, `Missing control: ${label}`);
      return control.props.onClick();
    },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
    flushRecorderEvents: () => {
      while (recorderEvents.length) recorderEvents.shift()();
    },
    recorders,
    sends,
  };
}

function createStream() {
  let stopCount = 0;
  return {
    getTracks: () => [
      {
        stop: () => {
          stopCount += 1;
        },
      },
    ],
    get stopCount() {
      return stopCount;
    },
  };
}

test("recording permission resolving after unmount releases the microphone", async (t) => {
  const permission = deferred();
  const stream = createStream();
  const composer = createComposer(t, () => permission.promise);
  const start = composer.click("Start recording");
  composer.unmount();
  permission.resolve(stream);
  await start;
  assert.equal(stream.stopCount, 1);
  assert.equal(composer.recorders.length, 0);
  assert.equal(composer.sends.length, 0);
});

test("rapid recording starts request one microphone stream", async (t) => {
  const permission = deferred();
  let permissionCount = 0;
  const composer = createComposer(t, () => {
    permissionCount += 1;
    return permission.promise;
  });
  const first = composer.click("Start recording");
  const second = composer.click("Start recording");
  permission.resolve(createStream());
  await Promise.all([first, second]);
  assert.equal(permissionCount, 1);
  assert.equal(composer.recorders.length, 1);
  composer.unmount();
});

test("unmounting an active recording discards it instead of sending", async (t) => {
  const stream = createStream();
  const composer = createComposer(t, async () => stream);
  await composer.click("Start recording");
  composer.recorders[0].ondataavailable({
    data: new Blob(["voice"], { type: "audio/ogg" }),
  });
  composer.unmount();
  composer.flushRecorderEvents();
  assert.equal(composer.recorders[0].stopCount, 1);
  assert.equal(composer.sends.length, 0);
  assert.ok(stream.stopCount > 0);
});

test("a recorder error stops and discards the recorder", async (t) => {
  t.mock.method(console, "error", () => {});
  const composer = createComposer(t, async () => createStream());
  await composer.click("Start recording");
  const recorder = composer.recorders[0];
  recorder.ondataavailable({
    data: new Blob(["voice"], { type: "audio/ogg" }),
  });
  recorder.onerror(new Error("Device disconnected"));
  composer.flushRecorderEvents();
  assert.equal(recorder.stopCount, 1);
  assert.equal(composer.sends.length, 0);
  composer.unmount();
});

test("Stop recording sends the clip once and releases the microphone", async (t) => {
  const stream = createStream();
  const composer = createComposer(t, async () => stream);
  await composer.click("Start recording");
  composer.render();
  const recorder = composer.recorders[0];
  recorder.ondataavailable({
    data: new Blob(["voice"], { type: "audio/ogg" }),
  });
  composer.click("Stop recording");
  composer.flushRecorderEvents();
  assert.equal(composer.sends.length, 1);
  assert.equal(composer.sends[0][2].mimeType, "audio/ogg");
  assert.equal(await composer.sends[0][2].file.text(), "voice");
  assert.equal(stream.stopCount, 1);
  composer.unmount();
  composer.flushRecorderEvents();
  assert.equal(composer.sends.length, 1);
});
