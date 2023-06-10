Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
let ms = 2000;
while (true) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}