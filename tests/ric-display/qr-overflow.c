// Standalone reproducer. Link only the installed QR C encoder, no host TFT.
#include <qrcode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char** argv) {
    if (argc != 3) { fprintf(stderr, "usage: qr-overflow VERSION PAYLOAD_LENGTH\n"); return 2; }
    int version = atoi(argv[1]), length = atoi(argv[2]);
    if (version < 1 || version > 40 || length < 0 || length > 4096) return 2;
    unsigned char* modules = malloc(qrcode_getBufferSize(version));
    char* text = malloc((size_t)length + 1);
    if (!modules || !text) return 2;
    memset(text, 'A', length); text[length] = 0;
    QRCode qr;
    fprintf(stderr, "Calling installed qrcode_initText: version=%d length=%d buffer=%u ECC_LOW\n",
            version, length, qrcode_getBufferSize(version));
    fflush(stderr);
    int status = qrcode_initText(&qr, modules, version, ECC_LOW, text);
    printf("{\"version\":%d,\"payloadLength\":%d,\"status\":%d,\"size\":%u}\n", version, length, status, qr.size);
    free(modules); free(text);
    return status == 0 ? 0 : 1;
}
