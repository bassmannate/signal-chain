export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["Off"] = 0] = "Off";
    LogLevel[LogLevel["Error"] = 1] = "Error";
    LogLevel[LogLevel["Warning"] = 2] = "Warning";
    LogLevel[LogLevel["Info"] = 4] = "Info";
    LogLevel[LogLevel["Debug"] = 8] = "Debug";
    LogLevel[LogLevel["Midi"] = 16] = "Midi";
    LogLevel[LogLevel["All"] = 4294967295] = "All";
})(LogLevel || (LogLevel = {}));
let logLevel = LogLevel.Warning; // Changed default from All to Warning
let logEntries = [];
const MAX_ENTRIES = 1000;
export function setLogLevel(level) {
    logLevel = level;
}
export function getLogLevel() {
    return logLevel;
}
export function shouldLog(level) {
    return (level & logLevel) === level;
}
export function getMaxEntries() {
    return MAX_ENTRIES;
}
export function clearLogEntries() {
    logEntries.length = 0;
}
function addLogEntry(level, tag, message) {
    const entry = {
        level,
        tag,
        message,
        timestamp: Date.now()
    };
    logEntries.push(entry);
    if (logEntries.length > MAX_ENTRIES) {
        logEntries.splice(0, logEntries.length - MAX_ENTRIES);
    }
}
export function log(level, tag, message) {
    if (!shouldLog(level)) return;
    addLogEntry(level, tag, message);
    // Also console log/warn/error for immediate visibility
    switch (level) {
        case LogLevel.Error:
            console.error(message);
            break;
        case LogLevel.Warning:
            console.warn(message);
            break;
        default:
            console.log(message);
            break;
    }
}
export function getLogText() {
    const lines = logEntries.map(entry => {
        const levelName = LogLevel[entry.level] || entry.level;
        const tagStr = entry.tag ? `[${entry.tag}] ` : '';
        const date = new Date(entry.timestamp).toISOString();
        return `${date} ${levelName} ${tagStr}${entry.message}`;
    });
    return lines.join('\n');
}
//# sourceMappingURL=Logger.js.map