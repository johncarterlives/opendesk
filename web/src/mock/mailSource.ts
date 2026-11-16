// The raw source of a mock message: a made-up RFC 5322 message with the headers a mail
// server adds on the way, as Show original reads it.

const crlf = (lines: string[]) => lines.join("\r\n");

export function rawMessage(m: { from: string; to: string; subject: string; date: string; messageId: string; text: string; received?: string }): string {
  const date = new Date(m.date).toUTCString().replace("GMT", "+0000");
  const host = m.received ?? "mx.margin.app";
  return (
    crlf([
      `Received: from mail.example.net (mail.example.net [203.0.113.7])`,
      `        by ${host} with ESMTPS id 4f3k2Q1x (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384); ${date}`,
      `Authentication-Results: ${host}; spf=pass smtp.mailfrom=${m.from.split("@")[1] ?? "example.net"}; dkim=pass header.d=${m.from.split("@")[1] ?? "example.net"}; dmarc=pass`,
      `Return-Path: <${m.from}>`,
      `From: ${m.from}`,
      `To: ${m.to}`,
      `Subject: ${m.subject}`,
      `Date: ${date}`,
      `Message-ID: <${m.messageId}>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      m.text,
    ]) + "\r\n"
  );
}

/** A source as a file the browser saves, named after the subject. */
export function sourceFile(raw: string, subject: string): Response {
  const name = `${subject.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 60) || "message"}.eml`;
  return new Response(raw, {
    status: 200,
    headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
}
