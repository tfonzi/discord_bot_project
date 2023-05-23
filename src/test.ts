let ms = 2000;
while (true) {
    console.log("hi");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}