
export function log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO]`, ...args);
}

export function warn(...args) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN]`, ...args);
}

export function error(...args) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR]`, ...args);
}

export function debug(...args) {
    if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [DEBUG]`, ...args);
    }
}
