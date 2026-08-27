// Gerador de .docx sem dependências: Markdown → OOXML → ZIP.
// Autocontido de propósito — não toca em DOM nem em APIs do Chrome, o que
// o torna testável isoladamente.

// ========== GERADOR DE .DOCX (sem dependências) ==========
// Converte Markdown (títulos, listas, tabelas, negrito, citações) num arquivo
// Word válido: um ZIP com [Content_Types].xml, _rels/.rels e word/document.xml
// usando formatação inline (não requer styles.xml).

function _xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _docxRuns(text, baseProps) {
  // Divide **negrito** em runs separados; remove marcações leves restantes
  var parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  var xml = '';
  parts.forEach(function(part) {
    if (!part) return;
    var bold = /^\*\*[^*]+\*\*$/.test(part);
    var clean = bold ? part.slice(2, -2) : part;
    clean = clean
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    var props = (bold ? '<w:b/>' : '') + (baseProps || '');
    xml += '<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') +
      '<w:t xml:space="preserve">' + _xmlEscape(clean) + '</w:t></w:r>';
  });
  return xml || '<w:r><w:t xml:space="preserve"></w:t></w:r>';
}

function _docxParagraph(text, opts) {
  opts = opts || {};
  var pPr = '<w:spacing w:after="' + (opts.heading ? '240' : '120') + '"/>';
  if (opts.indent) pPr = '<w:ind w:left="360"/>' + pPr;
  var runProps = '';
  if (opts.bold) runProps += '<w:b/>';
  if (opts.color) runProps += '<w:color w:val="' + opts.color + '"/>';
  if (opts.size) runProps += '<w:sz w:val="' + opts.size + '"/><w:szCs w:val="' + opts.size + '"/>';
  return '<w:p><w:pPr>' + pPr + '</w:pPr>' + _docxRuns(text, runProps) + '</w:p>';
}

function _docxTable(rows) {
  var xml = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function(edge) {
      return '<w:' + edge + ' w:val="single" w:sz="6" w:space="0" w:color="B9BECF"/>';
    }).join('') + '</w:tblBorders></w:tblPr>';
  rows.forEach(function(cells, rowIndex) {
    xml += '<w:tr>';
    cells.forEach(function(cell) {
      xml += '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>' +
        (rowIndex === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF0F6"/>' : '') +
        '</w:tcPr><w:p><w:pPr><w:spacing w:after="40"/></w:pPr>' +
        _docxRuns(cell, rowIndex === 0 ? '<w:b/>' : '') + '</w:p></w:tc>';
    });
    xml += '</w:tr>';
  });
  xml += '</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>';
  return xml;
}

function _markdownToDocxBody(md) {
  var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  var body = '';
  var i = 0;

  function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line || ''); }
  function isTableSep(line) { return /^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(line || ''); }
  function cells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
      .map(function(cell) { return cell.trim(); });
  }

  while (i < lines.length) {
    var line = lines[i];

    if (isTableRow(line) && isTableSep(lines[i + 1])) {
      var rows = [cells(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      body += _docxTable(rows);
      continue;
    }

    var match;
    if ((match = line.match(/^(#{1,6})\s+(.*)/))) {
      var sizes = { 1: 36, 2: 30, 3: 26 };
      body += _docxParagraph(match[2], { bold: true, heading: true, size: sizes[Math.min(match[1].length, 3)] });
    } else if ((match = line.match(/^\s*[-*]\s+(.*)/))) {
      body += _docxParagraph('• ' + match[1], { indent: true });
    } else if ((match = line.match(/^\s*(\d+)[.)]\s+(.*)/))) {
      body += _docxParagraph(match[1] + '. ' + match[2], { indent: true });
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B9BECF"/></w:pBdr><w:spacing w:after="160"/></w:pPr></w:p>';
    } else if ((match = line.match(/^\s*&?g?t?;?>\s?(.*)/)) && /^\s*(>|&gt;)/.test(line)) {
      body += _docxParagraph(line.replace(/^\s*(>|&gt;)\s?/, ''), { indent: true, color: '6B6F7D' });
    } else if (line.trim() !== '') {
      body += _docxParagraph(line);
    }
    i++;
  }
  return body || _docxParagraph('');
}

// --- ZIP writer (entradas "stored", sem compressão) ---
var _crcTable = null;
function _crc32(bytes) {
  if (!_crcTable) {
    _crcTable = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _buildZip(files) {
  var encoder = new TextEncoder();
  var chunks = [];
  var centralParts = [];
  var offset = 0;

  files.forEach(function(file) {
    var nameBytes = encoder.encode(file.name);
    var dataBytes = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    var crc = _crc32(dataBytes);

    var local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, dataBytes.length, true);
    local.setUint32(22, dataBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, dataBytes);

    var entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, 0, true); // stored
    entry.setUint32(16, crc, true);
    entry.setUint32(20, dataBytes.length, true);
    entry.setUint32(24, dataBytes.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + dataBytes.length;
  });

  var centralStart = offset;
  var centralSize = 0;
  centralParts.forEach(function(part) { chunks.push(part); centralSize += part.length; });

  var eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  chunks.push(new Uint8Array(eocd.buffer));

  var total = 0;
  chunks.forEach(function(chunk) { total += chunk.length; });
  var out = new Uint8Array(total);
  var pos = 0;
  chunks.forEach(function(chunk) { out.set(chunk, pos); pos += chunk.length; });
  return out;
}

function buildDocxBytes(markdown) {
  var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + _markdownToDocxBody(markdown) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return _buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml }
  ]);
}

function buildDocxBlob(markdown) {
  return new Blob([buildDocxBytes(markdown)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
