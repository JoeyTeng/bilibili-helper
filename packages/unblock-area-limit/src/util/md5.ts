const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0)

function toUtf8Bytes(input: string) {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(input)
    }
    const bytes: number[] = []
    for (const char of unescape(encodeURIComponent(input))) {
        bytes.push(char.charCodeAt(0))
    }
    return Uint8Array.from(bytes)
}

function rotateLeft(value: number, count: number) {
    return (value << count) | (value >>> (32 - count))
}

function toLittleEndianHex(value: number) {
    let result = ''
    for (let i = 0; i < 4; i++) {
        result += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    }
    return result
}

export function md5Hex(input: string) {
    const inputBytes = toUtf8Bytes(input)
    const bitLength = inputBytes.length * 8
    const paddedLength = (((inputBytes.length + 8) >>> 6) + 1) << 6
    const bytes = new Uint8Array(paddedLength)
    bytes.set(inputBytes)
    bytes[inputBytes.length] = 0x80

    const view = new DataView(bytes.buffer)
    view.setUint32(paddedLength - 8, bitLength, true)
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true)

    let a0 = 0x67452301
    let b0 = 0xefcdab89
    let c0 = 0x98badcfe
    let d0 = 0x10325476

    for (let offset = 0; offset < paddedLength; offset += 64) {
        const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true))

        let a = a0
        let b = b0
        let c = c0
        let d = d0

        for (let i = 0; i < 64; i++) {
            let f: number
            let g: number

            if (i < 16) {
                f = (b & c) | (~b & d)
                g = i
            } else if (i < 32) {
                f = (d & b) | (~d & c)
                g = (5 * i + 1) % 16
            } else if (i < 48) {
                f = b ^ c ^ d
                g = (3 * i + 5) % 16
            } else {
                f = c ^ (b | ~d)
                g = (7 * i) % 16
            }

            const nextD = c
            c = b
            b = (b + rotateLeft((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0
            a = d
            d = nextD
        }

        a0 = (a0 + a) >>> 0
        b0 = (b0 + b) >>> 0
        c0 = (c0 + c) >>> 0
        d0 = (d0 + d) >>> 0
    }

    return [a0, b0, c0, d0].map(toLittleEndianHex).join('')
}
