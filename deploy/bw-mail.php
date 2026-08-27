<?php
/**
 * bw-mail.php  —  HTTPS -> email relay for the Breadwright 3PL app.
 *
 * WHY: Railway blocks outbound SMTP ports, so the Node app can't send mail
 * directly. It POSTs the message here (over HTTPS) and this DreamHost-hosted
 * script sends it via the server's own mail() as no-reply@dynaradigital.com.
 * No third-party service, no signup.
 *
 * Deployed to dynaradigital.com. Key-gated with a shared secret (below); the
 * PHP source is never served, so the secret stays private.
 *
 * Request:  POST /bw-mail.php?key=SECRET   (or header X-Mail-Key: SECRET)
 *   body JSON { to: string|string[], subject, text, html?, from? }
 * Response: { ok: true, id } | { ok:false, error }
 */

$KEY = 'bwmail_CNxZ0HjjDF251Ta48XrdRt';

header('Content-Type: application/json');

$given = isset($_GET['key']) ? $_GET['key'] : (isset($_SERVER['HTTP_X_MAIL_KEY']) ? $_SERVER['HTTP_X_MAIL_KEY'] : '');
if (!hash_equals($KEY, (string)$given)) {
  http_response_code(401);
  echo json_encode(['ok' => false, 'error' => 'unauthorized']);
  exit;
}

$raw = file_get_contents('php://input');
$d = json_decode($raw, true);
if (!is_array($d) || empty($d['to']) || empty($d['subject'])) {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'need to + subject']);
  exit;
}

$to = is_array($d['to']) ? implode(', ', $d['to']) : (string)$d['to'];
$subject = (string)$d['subject'];
$from = isset($d['from']) && $d['from'] ? (string)$d['from'] : 'Breadwright 3PL <no-reply@dynaradigital.com>';
$text = isset($d['text']) ? (string)$d['text'] : '';
$html = isset($d['html']) ? (string)$d['html'] : '';

$eol = "\r\n";
$headers = [];
$headers[] = 'From: ' . $from;
$headers[] = 'Reply-To: no-reply@dynaradigital.com';
$headers[] = 'MIME-Version: 1.0';
$headers[] = 'X-Mailer: bw-mail-relay';

if ($html !== '') {
  $boundary = 'bw' . bin2hex(random_bytes(10));
  $headers[] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';
  $body  = '--' . $boundary . $eol;
  $body .= 'Content-Type: text/plain; charset=UTF-8' . $eol . $eol;
  $body .= ($text !== '' ? $text : strip_tags($html)) . $eol . $eol;
  $body .= '--' . $boundary . $eol;
  $body .= 'Content-Type: text/html; charset=UTF-8' . $eol . $eol;
  $body .= $html . $eol . $eol;
  $body .= '--' . $boundary . '--' . $eol;
} else {
  $headers[] = 'Content-Type: text/plain; charset=UTF-8';
  $body = $text;
}

$ok = @mail($to, $subject, $body, implode($eol, $headers), '-fno-reply@dynaradigital.com');
if ($ok) {
  echo json_encode(['ok' => true, 'id' => 'mail-' . time()]);
} else {
  http_response_code(502);
  $e = error_get_last();
  echo json_encode(['ok' => false, 'error' => $e ? $e['message'] : 'mail() returned false']);
}
