#define BCDEC_STATIC
#define BCDEC_IMPLEMENTATION
#include "bcdec.h"

static unsigned char blocks[1024 * 2048];
static unsigned char signal[1024 * 2048];

unsigned char *input(void) { return blocks; }
unsigned char *output(void) { return signal; }

static void decode_material(int width, int height, int bc3) {
    if (width < 4 || height < 4 || width > 512 || height > 512 || width % 4 || height % 4) return;
    for (int y = 0; y < height; y += 4) {
        for (int x = 0; x < width; x += 4) {
            const unsigned char *block = blocks + ((y / 4) * (width / 4) + x / 4) * 16;
            unsigned char *pixel = signal + (y * width + x) * 4;
            if (bc3) bcdec_bc3(block, pixel, width * 4);
            else bcdec_bc7(block, pixel, width * 4);
        }
    }
}

void decode_bc3(int width, int height) { decode_material(width, height, 1); }
void decode_bc7(int width, int height) { decode_material(width, height, 0); }

void decode_night(int width, int height) {
    if (width != 1024 || height != 2048) return;
    for (int y = 0; y < height; y += 4) {
        for (int x = 0; x < width; x += 4) {
            float rgb[48];
            bcdec_bc6h_float(blocks + ((y / 4) * (width / 4) + x / 4) * 16, rgb, 12, 0);
            for (int row = 0; row < 4; ++row) {
                for (int col = 0; col < 4; ++col) {
                    float *p = rgb + (row * 4 + col) * 3;
                    int channels[3];
                    for (int c = 0; c < 3; ++c) {
                        float v = p[c] * 255;
                        channels[c] = v >= 255 ? 255 : v > 0 ? (int)(v + 0.5f) : 0;
                    }
                    signal[(y + row) * width + x + col] =
                        (unsigned char)((channels[0] * 299 + channels[1] * 587 + channels[2] * 114 + 500) / 1000);
                }
            }
        }
    }
}
