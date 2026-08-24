import type { ModelAdapter, ModelRequest, ModelResponse } from '@runguild/protocol'

export class ScriptedModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  private cursor = 0

  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly responses: readonly ModelResponse[],
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const response = this.responses[this.cursor]
    if (!response) {
      throw new Error('Scripted model response queue exhausted at call ' + this.cursor)
    }
    this.cursor += 1
    return response
  }
}
