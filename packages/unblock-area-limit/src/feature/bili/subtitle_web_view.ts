const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface ProtoField {
    fieldNumber: number
    wireType: number
    value?: bigint
    bytes?: Uint8Array
}

interface SubtitleItem {
    fields: ProtoField[]
    id?: bigint
    lan?: string
    lanDoc?: string
    subtitleUrl?: string
}

interface RewriteOptions {
    generateSub?: boolean
}

export function rewriteSubtitleWebViewResponse(response: unknown, options: RewriteOptions): ArrayBuffer | null {
    if (!options.generateSub) return null

    const bytes = responseToBytes(response)
    if (!bytes) return null

    try {
        const topFields = decodeMessage(bytes)
        const dataField = topFields.find((field) => field.fieldNumber === 1 && field.wireType === 2 && field.bytes)
        if (!dataField?.bytes) return null

        const dataFields = decodeMessage(dataField.bytes)
        const subtitles = dataFields
            .filter((field) => field.fieldNumber === 3 && field.wireType === 2 && field.bytes)
            .map((field) => parseSubtitleItem(field.bytes!))
            .filter((item): item is SubtitleItem => Boolean(item))

        const generated = createGeneratedSubtitle(subtitles)
        if (!generated) return null

        dataFields.push({
            fieldNumber: 3,
            wireType: 2,
            bytes: encodeMessage(generated.fields),
        })
        dataField.bytes = encodeMessage(dataFields)

        const output = encodeMessage(topFields)
        return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
    } catch (error) {
        return null
    }
}

function responseToBytes(response: unknown): Uint8Array | null {
    if (response instanceof ArrayBuffer) {
        return new Uint8Array(response)
    }
    if (ArrayBuffer.isView(response)) {
        return new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
    }
    return null
}

function createGeneratedSubtitle(subtitles: SubtitleItem[]): SubtitleItem | null {
    const lans = subtitles.map((item) => item.lan)
    const genHans = lans.includes('zh-Hant') && !lans.includes('zh-Hans')
    const genHant = lans.includes('zh-Hans') && !lans.includes('zh-Hant')
    if (!genHans && !genHant) return null

    const origin = genHans ? 'zh-Hant' : 'zh-Hans'
    const target = genHans ? 'zh-Hans' : 'zh-Hant'
    const targetDoc = genHans ? '中文（简体）生成' : '中文（繁体）生成'
    const from = origin === 'zh-Hant' ? 'tw' : 'cn'
    const to = target === 'zh-Hans' ? 'cn' : 'tw'
    const source = subtitles.find((item) => item.lan === origin && item.subtitleUrl)
    if (!source?.subtitleUrl) return null

    const nextId = subtitles.reduce((max, item) => {
        if (item.id != null && item.id > max) return item.id
        return max
    }, 0n) + 1n
    const fields = cloneFields(source.fields)
    setVarintField(fields, 1, nextId)
    setTextField(fields, 2, nextId.toString())
    setTextField(fields, 3, target)
    setTextField(fields, 4, targetDoc)
    setTextField(fields, 5, appendTranslateParams(source.subtitleUrl, from, to))

    return {
        fields,
        id: nextId,
        lan: target,
        lanDoc: targetDoc,
        subtitleUrl: getTextField(fields, 5),
    }
}

function parseSubtitleItem(bytes: Uint8Array): SubtitleItem | null {
    const fields = decodeMessage(bytes)
    const lan = getTextField(fields, 3)
    const subtitleUrl = getTextField(fields, 5)
    if (!lan || !subtitleUrl) return null

    return {
        fields,
        id: fields.find((field) => field.fieldNumber === 1 && field.wireType === 0)?.value,
        lan,
        lanDoc: getTextField(fields, 4),
        subtitleUrl,
    }
}

function appendTranslateParams(rawUrl: string, from: string, to: string): string {
    const protocolRelative = rawUrl.startsWith('//')
    const url = new URL(rawUrl, 'https://www.bilibili.com')
    url.searchParams.set('translate', '1')
    url.searchParams.set('from', from)
    url.searchParams.set('to', to)
    if (!protocolRelative) return url.href
    return `//${url.host}${url.pathname}${url.search}${url.hash}`
}

function getTextField(fields: ProtoField[], fieldNumber: number): string | undefined {
    const field = fields.find((item) => item.fieldNumber === fieldNumber && item.wireType === 2 && item.bytes)
    return field?.bytes ? decoder.decode(field.bytes) : undefined
}

function setTextField(fields: ProtoField[], fieldNumber: number, value: string) {
    setBytesField(fields, fieldNumber, encoder.encode(value))
}

function setBytesField(fields: ProtoField[], fieldNumber: number, bytes: Uint8Array) {
    const field = fields.find((item) => item.fieldNumber === fieldNumber && item.wireType === 2)
    if (field) {
        field.bytes = bytes
    } else {
        fields.push({ fieldNumber, wireType: 2, bytes })
    }
}

function setVarintField(fields: ProtoField[], fieldNumber: number, value: bigint) {
    const field = fields.find((item) => item.fieldNumber === fieldNumber && item.wireType === 0)
    if (field) {
        field.value = value
    } else {
        fields.push({ fieldNumber, wireType: 0, value })
    }
}

function cloneFields(fields: ProtoField[]): ProtoField[] {
    return fields.map((field) => ({
        fieldNumber: field.fieldNumber,
        wireType: field.wireType,
        value: field.value,
        bytes: field.bytes ? new Uint8Array(field.bytes) : undefined,
    }))
}

function decodeMessage(bytes: Uint8Array): ProtoField[] {
    const fields: ProtoField[] = []
    let offset = 0
    while (offset < bytes.length) {
        const key = readVarint(bytes, offset)
        offset = key.offset
        const fieldNumber = Number(key.value >> 3n)
        const wireType = Number(key.value & 7n)
        if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`)

        if (wireType === 0) {
            const value = readVarint(bytes, offset)
            offset = value.offset
            fields.push({ fieldNumber, wireType, value: value.value })
        } else if (wireType === 1) {
            const end = offset + 8
            assertAvailable(bytes, end)
            fields.push({ fieldNumber, wireType, bytes: bytes.slice(offset, end) })
            offset = end
        } else if (wireType === 2) {
            const length = readVarint(bytes, offset)
            offset = length.offset
            const end = offset + Number(length.value)
            assertAvailable(bytes, end)
            fields.push({ fieldNumber, wireType, bytes: bytes.slice(offset, end) })
            offset = end
        } else if (wireType === 5) {
            const end = offset + 4
            assertAvailable(bytes, end)
            fields.push({ fieldNumber, wireType, bytes: bytes.slice(offset, end) })
            offset = end
        } else {
            throw new Error(`Unsupported protobuf wire type: ${wireType}`)
        }
    }
    return fields
}

function encodeMessage(fields: ProtoField[]): Uint8Array {
    const parts: Uint8Array[] = []
    for (const field of fields) {
        parts.push(writeVarint(BigInt((field.fieldNumber << 3) | field.wireType)))
        if (field.wireType === 0) {
            parts.push(writeVarint(field.value ?? 0n))
        } else if (field.wireType === 1 || field.wireType === 5) {
            if (!field.bytes) throw new Error(`Missing fixed bytes for field ${field.fieldNumber}`)
            parts.push(field.bytes)
        } else if (field.wireType === 2) {
            const bytes = field.bytes ?? new Uint8Array()
            parts.push(writeVarint(BigInt(bytes.byteLength)))
            parts.push(bytes)
        } else {
            throw new Error(`Unsupported protobuf wire type: ${field.wireType}`)
        }
    }
    return concat(parts)
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint, offset: number } {
    let value = 0n
    let shift = 0n
    let offset = start
    while (offset < bytes.length) {
        const byte = bytes[offset++]
        value |= BigInt(byte & 0x7f) << shift
        if ((byte & 0x80) === 0) return { value, offset }
        shift += 7n
        if (shift > 63n) throw new Error(`Varint too long at ${start}`)
    }
    throw new Error(`Unterminated varint at ${start}`)
}

function writeVarint(value: bigint): Uint8Array {
    const bytes: number[] = []
    let rest = value
    while (rest >= 0x80n) {
        bytes.push(Number((rest & 0x7fn) | 0x80n))
        rest >>= 7n
    }
    bytes.push(Number(rest))
    return new Uint8Array(bytes)
}

function concat(parts: Uint8Array[]): Uint8Array {
    const length = parts.reduce((total, part) => total + part.byteLength, 0)
    const output = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
        output.set(part, offset)
        offset += part.byteLength
    }
    return output
}

function assertAvailable(bytes: Uint8Array, end: number) {
    if (end > bytes.length) {
        throw new Error(`Truncated protobuf message: need ${end}, have ${bytes.length}`)
    }
}
