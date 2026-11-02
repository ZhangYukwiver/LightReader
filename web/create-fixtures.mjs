// Test-only documents, never loaded into the user's library automatically.
import { zipSync, strToU8 } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
const directory = new URL('./output/playwright/fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
const text = '第一章 阅读测试\n\n这是一份用于验证网页端的测试文档。轻阅保留批注和阅读进度。\n\n' + '文字内容只保存在本浏览器。\n'.repeat(250) + '\n第二章 继续阅读\n阅读到这里。';
await writeFile(new URL('阅读测试.txt', directory), text);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const files = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Word 网页测试</w:t></w:r></w:p><w:p><w:r><w:t>这段正文包含 &lt;script&gt;alert(1)&lt;/script&gt;，应当作为普通文字显示。</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:fill="DBECE5"/></w:tcPr><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>原来的内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  'customXml/item1.xml': '<preserve>original package part</preserve>'
};
await writeFile(new URL('Word测试.docx', directory), zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)]))));
console.log('TXT / DOCX 验证文件已生成到 output/playwright/fixtures');
