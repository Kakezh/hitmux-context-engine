import OpenAI from 'openai';
import { OpenAIEmbedding } from './openai-embedding';

const mockCreate = jest.fn();

jest.mock('openai', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        embeddings: {
            create: mockCreate,
        },
    })),
}));

describe('OpenAIEmbedding', () => {
    beforeEach(() => {
        mockCreate.mockReset();
        (OpenAI as unknown as jest.Mock).mockClear();
    });

    it('caches detected dimensions per baseURL and model', async () => {
        mockCreate
            .mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3] }] })
            .mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3, 4, 5] }] });

        const first = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'custom-embedding',
            baseURL: 'https://provider-a.example/v1/',
        });
        const second = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'custom-embedding',
            baseURL: 'https://provider-b.example/v1',
        });

        await expect(first.detectDimension()).resolves.toBe(3);
        await expect(second.detectDimension()).resolves.toBe(5);
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('normalizes equivalent baseURL values for dimension cache keys', async () => {
        mockCreate.mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3, 4] }] });

        const first = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'same-provider-custom-embedding',
            baseURL: 'https://provider.example/v1/',
        });
        const second = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'same-provider-custom-embedding',
            baseURL: 'https://provider.example/v1',
        });

        await expect(first.detectDimension()).resolves.toBe(4);
        await expect(second.detectDimension()).resolves.toBe(4);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });
});
