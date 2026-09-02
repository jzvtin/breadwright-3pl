<?php
/**
 * bw-audit.php — append-only audit log of every product sent to Ice Cube
 * Cold Storage (ICCS), for safety/compliance review. Same relay pattern as
 * bw-mail.php (Railway can't hold persistent disk across redeploys, so the
 * durable copy lives here instead).
 *
 * POST /bw-audit.php?key=SECRET   body JSON { rows: [ {ts,date,order,customer,
 *   city,state,serviceTier,dryIceSlabs,declareDryIce,contents,filename,
 *   approvedBy,sentVia} , ... ] }   -> appends each as a CSV row
 * GET  /bw-audit.php?key=SECRET&download=1  -> the full CSV (audit review)
 *
 * The CSV lives OUTSIDE the web docroot (one level up) so it is never
 * directly guessable/fetchable without the key, even though this script is.
 */

$KEY = 'bwaudit_9f2Lp7xVe4wTnKq8sYdR3cM6zXhB1uJa';
$LOG_PATH = __DIR__ . '/../breadwright-audit.csv';
$COLUMNS = ['ts','date','order','customer','city','state','serviceTier','dryIceSlabs','declareDryIce','contents','filename','approvedBy','sentVia'];

header('Content-Type: application/json');

$given = isset($_GET['key']) ? $_GET['key'] : (isset($_SERVER['HTTP_X_AUDIT_KEY']) ? $_SERVER['HTTP_X_AUDIT_KEY'] : '');
if (!hash_equals($KEY, (string)$given)) {
  http_response_code(401);
  echo json_encode(['ok' => false, 'error' => 'unauthorized']);
  exit;
}

function csv_line($fields) {
  $out = [];
  foreach ($fields as $f) {
    $f = (string)$f;
    if (preg_match('/[",\n]/', $f)) $f = '"' . str_replace('"', '""', $f) . '"';
    $out[] = $f;
  }
  return implode(',', $out) . "\n";
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  if (!file_exists($LOG_PATH)) {
    header('Content-Type: text/csv');
    echo csv_line($COLUMNS);
    exit;
  }
  header('Content-Type: text/csv');
  header('Content-Disposition: attachment; filename="breadwright-audit.csv"');
  readfile($LOG_PATH);
  exit;
}

$raw = file_get_contents('php://input');
$d = json_decode($raw, true);
$rows = isset($d['rows']) && is_array($d['rows']) ? $d['rows'] : null;
if (!$rows) {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'need rows: []']);
  exit;
}

$isNew = !file_exists($LOG_PATH);
$fh = fopen($LOG_PATH, 'a');
if (!$fh) {
  http_response_code(500);
  echo json_encode(['ok' => false, 'error' => 'cannot open log file']);
  exit;
}
if (flock($fh, LOCK_EX)) {
  if ($isNew) fwrite($fh, csv_line($COLUMNS));
  $written = 0;
  foreach ($rows as $r) {
    $line = [];
    foreach ($COLUMNS as $c) $line[] = isset($r[$c]) ? $r[$c] : '';
    fwrite($fh, csv_line($line));
    $written++;
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  echo json_encode(['ok' => true, 'written' => $written]);
} else {
  fclose($fh);
  http_response_code(503);
  echo json_encode(['ok' => false, 'error' => 'lock failed, retry']);
}
