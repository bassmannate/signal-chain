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
let logLevel = LogLevel.All;
export function setLogLevel(level) {
    logLevel = level;
}
export function getLogLevel() {
    return logLevel;
}
export function shouldLog(level) {
    return (level & logLevel) === level;
}
//# sourceMappingURL=Logger.js.map