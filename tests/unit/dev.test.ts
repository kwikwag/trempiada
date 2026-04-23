import assert from "node:assert/strict";
import test from "node:test";
import { formatRecentUsersMessage } from "../../src/bot/dev";

test("formatRecentUsersMessage escapes HTML-sensitive user fields", () => {
  const message = formatRecentUsersMessage([
    {
      id: 433406108,
      firstName: "Avi_<b>",
      lastName: 'O"Neil & Sons',
      username: "name<test>",
      seenAt: new Date("2026-04-23T09:19:32.000Z"),
    },
  ]);

  assert.match(message, /^<b>Last 1 users:<\/b>\n/);
  assert.ok(message.includes("<code>433406108</code>"));
  assert.ok(message.includes("Avi_&lt;b&gt; O&quot;Neil &amp; Sons"));
  assert.ok(message.includes("@name&lt;test&gt;"));
  assert.ok(message.includes("2026-04-23 09:19:32"));
});
