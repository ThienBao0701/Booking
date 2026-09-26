/**
 * Task Scheduler registration (Phase 15, ADR-0010): the supervisor runs as the
 * operator (least privilege, interactive token) from logon — including after
 * a reboot — hidden, with no time limit, one instance, restarted by Task
 * Scheduler if the supervisor itself exits abnormally.
 *
 * `schtasks /Create /XML` expects UTF-16; `encodeTaskXml` adds the BOM.
 */

export const TASK_NAME = "AutomationLab";

export interface TaskSpec {
  /** DOMAIN\user (or user) the task runs as; also the logon trigger's user. */
  userId: string;
  command: string;
  arguments: string;
  workingDirectory: string;
  description?: string;
  /** Delay after logon before starting (ISO 8601 duration, default PT10S). */
  logonDelay?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function taskXml(t: TaskSpec): string {
  for (const [k, v] of Object.entries({ userId: t.userId, command: t.command, workingDirectory: t.workingDirectory })) {
    if (!v || /[\r\n\0]/.test(v)) throw new Error(`task ${k} is empty or contains control characters`);
  }
  if (/[\r\n\0]/.test(t.arguments)) throw new Error("task arguments contain control characters");
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>${esc(t.description ?? "Automation Lab local service (127.0.0.1 only), supervised")}</Description>`,
    `    <URI>\\${TASK_NAME}</URI>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Enabled>true</Enabled>`,
    `      <UserId>${esc(t.userId)}</UserId>`,
    `      <Delay>${esc(t.logonDelay ?? "PT10S")}</Delay>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${esc(t.userId)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings>`,
    `      <StopOnIdleEnd>false</StopOnIdleEnd>`,
    `      <RestartOnIdle>false</RestartOnIdle>`,
    `    </IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>true</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>999</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${esc(t.command)}</Command>`,
    `      <Arguments>${esc(t.arguments)}</Arguments>`,
    `      <WorkingDirectory>${esc(t.workingDirectory)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

/** UTF-16LE with BOM, as schtasks expects. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

/** Read back the Exec action of a task XML (status checks and tests). */
export function parseTaskAction(xml: string): { command: string; arguments: string; workingDirectory: string } | undefined {
  const un = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
    return m ? un(m[1] as string) : undefined;
  };
  const command = pick("Command");
  if (command === undefined) return undefined;
  return { command, arguments: pick("Arguments") ?? "", workingDirectory: pick("WorkingDirectory") ?? "" };
}

/** Quote one argument for a Windows command line (CommandLineToArgvW rules). */
export function winQuote(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** Split a command line produced by `winQuote` (the inverse; used to replay a task in tests). */
export function winSplit(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) break;
    let cur = "";
    let quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i] as string;
      if (!quoted && (ch === " " || ch === "\t")) break;
      if (ch === "\\") {
        let n = 0;
        while (line[i] === "\\") {
          n++;
          i++;
        }
        if (line[i] === '"') {
          cur += "\\".repeat(Math.floor(n / 2));
          if (n % 2 === 1) cur += '"';
          else quoted = !quoted;
        } else {
          cur += "\\".repeat(n);
          i--;
        }
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      cur += ch;
    }
    out.push(cur);
  }
  return out;
}
