"""Bounded, single-image thumbnail worker. Output: width/height (8 bytes), then JPEG."""
import io
import resource
import struct
import sys
import warnings

# The parent runs at most one worker and also imposes a wall-clock deadline.
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 24_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)


def thumbnail(path):
    with Image.open(path, formats=['JPEG', 'PNG', 'WEBP', 'GIF']) as source:
        if source.width * source.height > 24_000_000:
            raise ValueError('Image exceeds preview pixel limit')
        # JPEG draft reduction happens before a large RGB image is allocated.
        source.thumbnail((640, 640), Image.Resampling.LANCZOS, reducing_gap=2.0)
        oriented = ImageOps.exif_transpose(source)
        rgba = oriented.convert('RGBA')
        image = Image.new('RGB', rgba.size, 'white')
        image.paste(rgba, mask=rgba.getchannel('A'))
        image.info.clear()
        for side, quality in [(640, 75), (640, 60), (480, 65), (320, 60)]:
            image.thumbnail((side, side), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=quality, exif=b'', icc_profile=None)
            body = output.getvalue()
            if len(body) <= 100 * 1024:
                return struct.pack('>II', *image.size) + body
        raise ValueError('Preview exceeds byte limit')


if __name__ == '__main__':
    try:
        sys.stdout.buffer.write(thumbnail(sys.argv[1]))
    except (OSError, ValueError, MemoryError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise SystemExit(1)
