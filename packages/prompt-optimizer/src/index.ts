import { IntentExtractor } from './intent-extractor';
import { PatternDetector } from './pattern-detector';
import { FrameworkRouter } from './framework-router';
import { TokenAuditor } from './token-auditor';

export * from './types';

export { IntentExtractor } from './intent-extractor';
export { PatternDetector } from './pattern-detector';
export { FrameworkRouter } from './framework-router';
export { TokenAuditor } from './token-auditor';

export class PromptOptimizer {
  private intentExtractor: IntentExtractor;
  private patternDetector: PatternDetector;
  private frameworkRouter: FrameworkRouter;
  private tokenAuditor: TokenAuditor;

  constructor() {
    this.intentExtractor = new IntentExtractor();
    this.patternDetector = new PatternDetector();
    this.frameworkRouter = new FrameworkRouter();
    this.tokenAuditor = new TokenAuditor();
  }

  async optimize(prompt: string, toolTarget?: string) {
    // 1. Extract intent dimensions
    const intent = await this.intentExtractor.extract(prompt);

    // 2. Detect patterns
    const patterns = this.patternDetector.analyze(prompt, intent);
    const qualityScore = this.patternDetector.scoreQuality(patterns, intent);

    // 3. Route to framework
    const framework = await this.frameworkRouter.select(intent, toolTarget);

    // 4. Token audit
    const optimized = await this.tokenAuditor.optimize(prompt, framework);
    const tokenDelta = this.tokenAuditor.calculateDelta(prompt, optimized);

    return {
      original: prompt,
      optimized,
      framework,
      toolTarget: (toolTarget as any) || 'unknown',
      qualityScore,
      strategy: this.generateStrategy(framework, patterns),
      tokenDelta,
    };
  }

  private generateStrategy(framework: string, patterns: any[]): string {
    const critical = patterns.filter((p) => p.severity === 'critical');
    if (critical.length > 0) {
      return `Fixed ${critical.length} critical pattern(s): ${critical.map((p) => p.pattern).join(', ')}. Applied ${framework} framework.`;
    }
    return `Optimized for efficiency. Applied ${framework} framework.`;
  }
}
