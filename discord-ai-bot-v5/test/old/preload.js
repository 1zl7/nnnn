// يسرّع المؤقتات (الكود القديم فيه انتظار 60 ثانية ثابت) ويثبّت العشوائية عشان النتائج تتكرر
const SCALE = Number(process.env.TIME_SCALE || 20);
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, (ms || 0) / SCALE, ...args);
Math.random = () => 0.1;
