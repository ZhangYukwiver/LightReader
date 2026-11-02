"""Generate a small real PDF covering text, image-only, rotated and CJK pages.

Usage: python3 app/src/test/js/create-pdf-fixture.py build/pdf-fixture.pdf
No external libraries; not application/sample user data.
"""
from pathlib import Path
import sys

objects = []


def obj(data):
    objects.append(data.encode('ascii') if isinstance(data, str) else data)
    return len(objects)


def stream(data, extra=''):
    return obj(f'<< /Length {len(data)} {extra} >>\nstream\n'.encode() + data + b'\nendstream')


obj('<< /Type /Catalog /Pages 2 0 R >>')
obj('')
font = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
cid = obj('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light '
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>')
cjk = obj(f'<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light '
          f'/Encoding /UniGB-UCS2-H /DescendantFonts [{cid} 0 R] >>')
image = stream(bytes([235, 242, 249, 70, 110, 155, 70, 110, 155, 235, 242, 249]),
               '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8')
texts = [
    b'BT /F1 24 Tf 48 700 Td (PDF annotation test) Tj 0 -40 Td '
    b'(Highlight this first line.) Tj 0 -36 Td (Continue on the second line.) Tj ET',
    f'q 460 0 0 620 70 80 cm /Im1 Do Q'.encode(),
    b'BT /F1 24 Tf 48 700 Td (Rotated page selection) Tj ET',
    ('BT /F2 24 Tf 48 700 Td <' + '中文批注测试'.encode('utf-16-be').hex() + '> Tj '
     '0 -40 Td <' + '选中这段文字添加批注'.encode('utf-16-be').hex() + '> Tj ET').encode()
]
pages = []
for index, content in enumerate(texts):
    content_id = stream(content)
    pages.append(obj(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] '
                     f'/Rotate {90 if index == 2 else 0} /Resources << /Font << /F1 {font} 0 R /F2 {cjk} 0 R >> '
                     f'/XObject << /Im1 {image} 0 R >> >> /Contents {content_id} 0 R >>'))
objects[1] = f'<< /Type /Pages /Count {len(pages)} /Kids [{" ".join(f"{p} 0 R" for p in pages)}] >>'.encode()
data = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for number, content in enumerate(objects, 1):
    offsets.append(len(data))
    data += f'{number} 0 obj\n'.encode() + content + b'\nendobj\n'
xref = len(data)
data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
for offset in offsets[1:]:
    data += f'{offset:010d} 00000 n \n'.encode()
data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(data)
print(f'{target}: {len(data)} bytes, {len(pages)} pages')
