/**
 * IMPROVED SIMILARITY ALGORITHM PROPOSAL
 *
 * Problems with current algorithm:
 * 1. No semantic understanding (resize ≠ resizer)
 * 2. Language barriers (Spanish vs English)
 * 3. Ignores file/component context
 * 4. Simple word matching misses relationships
 */

class ImprovedSimilarityCalculator {

  constructor() {
    // Common programming synonyms and related terms
    this.synonymGroups = [
      ['fix', 'repair', 'resolve', 'arreglar', 'corregir', 'solucionar'],
      ['resize', 'resizer', 'resizing', 'redimensionar'],
      ['cursor', 'pointer', 'puntero'],
      ['detection', 'detect', 'detecting', 'detección', 'detectar'],
      ['config', 'configuration', 'configuración', 'configurar', 'setup'],
      ['clean', 'cleanup', 'remove', 'limpiar', 'eliminar', 'borrar'],
      ['link', 'enlace', 'vínculo'],
      ['settings', 'setting', 'config', 'configuración', 'ajustes'],
      ['danger', 'dangerous', 'peligro', 'peligroso'],
      ['mode', 'modo'],
      ['notification', 'notify', 'notificación', 'notificar'],
      ['optimization', 'optimize', 'optimización', 'optimizar'],
      ['upper', 'top', 'superior', 'arriba'],
      ['lower', 'bottom', 'inferior', 'abajo'],
      ['half', 'mitad', 'portion', 'parte', 'área', 'zona']
    ];

    // Component/feature keywords that indicate same context
    this.componentKeywords = {
      'resizer': ['resize', 'cursor', 'drag', 'panel', 'divider', 'vertical', 'horizontal'],
      'notion': ['mcp', 'notion', 'api', 'integration', 'marketplace'],
      'turbo_mode': ['danger', 'mode', 'skip', 'wait', 'permission', 'safety'],
      'optimization': ['claude', 'cleanup', 'performance', 'conversation', 'backup'],
      'settings': ['modal', 'config', 'preference', 'option', 'checkbox', 'toggle']
    };
  }

  /**
   * Calculate improved similarity with semantic understanding
   */
  calculateImprovedSimilarity(text1, text2, metadata = {}) {
    const score = {
      jaccard: 0,      // Basic word overlap (current method)
      semantic: 0,     // Synonym/related term matching
      component: 0,    // Same component/feature detection
      progressive: 0,  // Progressive refinement pattern
      language: 0      // Cross-language matching
    };

    // 1. Original Jaccard similarity (for baseline)
    score.jaccard = this.calculateJaccardSimilarity(text1, text2);

    // 2. Semantic similarity (synonyms and related terms)
    score.semantic = this.calculateSemanticSimilarity(text1, text2);

    // 3. Component/feature detection
    score.component = this.detectSameComponent(text1, text2);

    // 4. Progressive refinement pattern detection
    score.progressive = this.detectProgressiveRefinement(text1, text2);

    // 5. Cross-language similarity
    score.language = this.calculateCrossLanguageSimilarity(text1, text2);

    // Weighted combination
    const weights = {
      jaccard: 0.2,     // Reduced from 1.0
      semantic: 0.3,    // New: Important for variations
      component: 0.25,  // New: Same feature detection
      progressive: 0.15,// New: Refinement patterns
      language: 0.1     // New: Multi-language support
    };

    let finalScore = 0;
    for (const [key, weight] of Object.entries(weights)) {
      finalScore += score[key] * weight;
    }

    // Boost if titles are very similar (keep original boost concept)
    const titleSimilarity = this.calculateJaccardSimilarity(
      text1.split(' ').slice(0, 5).join(' '),
      text2.split(' ').slice(0, 5).join(' ')
    );
    if (titleSimilarity > 0.6) {
      finalScore = Math.min(1, finalScore + 0.15);
    }

    return {
      finalScore,
      breakdown: score,
      recommendation: this.getRecommendation(finalScore, score)
    };
  }

  /**
   * Original Jaccard similarity (current implementation)
   */
  calculateJaccardSimilarity(text1, text2) {
    const normalize = (text) => {
      return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);
    };

    const words1 = new Set(normalize(text1));
    const words2 = new Set(normalize(text2));

    if (words1.size === 0 || words2.size === 0) return 0;

    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return intersection / union;
  }

  /**
   * Semantic similarity using synonym groups
   */
  calculateSemanticSimilarity(text1, text2) {
    const words1 = this.extractWords(text1);
    const words2 = this.extractWords(text2);

    let matches = 0;
    let total = Math.max(words1.length, words2.length);

    for (const word1 of words1) {
      for (const word2 of words2) {
        if (this.areWordsSemanticallyRelated(word1, word2)) {
          matches++;
          break;
        }
      }
    }

    return total > 0 ? matches / total : 0;
  }

  /**
   * Check if two words are in the same synonym group
   */
  areWordsSemanticallyRelated(word1, word2) {
    if (word1 === word2) return true;

    for (const group of this.synonymGroups) {
      if (group.includes(word1) && group.includes(word2)) {
        return true;
      }
    }

    // Check for word stems (simple stemming)
    const stem1 = word1.substring(0, Math.min(4, word1.length));
    const stem2 = word2.substring(0, Math.min(4, word2.length));

    return stem1 === stem2 && stem1.length >= 3;
  }

  /**
   * Detect if tasks are about the same component/feature
   */
  detectSameComponent(text1, text2) {
    const words1 = this.extractWords(text1);
    const words2 = this.extractWords(text2);

    for (const [component, keywords] of Object.entries(this.componentKeywords)) {
      const matches1 = keywords.filter(k => words1.includes(k)).length;
      const matches2 = keywords.filter(k => words2.includes(k)).length;

      // If both texts have multiple keywords from same component
      if (matches1 >= 2 && matches2 >= 2) {
        return 0.8; // High component similarity
      }
      if (matches1 >= 1 && matches2 >= 1) {
        return 0.5; // Moderate component similarity
      }
    }

    return 0;
  }

  /**
   * Detect progressive refinement patterns
   */
  detectProgressiveRefinement(text1, text2) {
    const refinementPatterns = [
      ['add', 'fix', 'improve', 'update', 'remove'],
      ['añadir', 'arreglar', 'mejorar', 'actualizar', 'quitar'],
      ['implement', 'debug', 'refactor', 'optimize'],
      ['implementar', 'depurar', 'refactorizar', 'optimizar']
    ];

    const words1 = this.extractWords(text1);
    const words2 = this.extractWords(text2);

    // Check if both texts contain refinement verbs
    for (const pattern of refinementPatterns) {
      const hasRefinement1 = pattern.some(p => words1.includes(p));
      const hasRefinement2 = pattern.some(p => words2.includes(p));

      if (hasRefinement1 && hasRefinement2) {
        // Check for common nouns (what's being refined)
        const nouns1 = words1.filter(w => !pattern.includes(w));
        const nouns2 = words2.filter(w => !pattern.includes(w));

        const commonNouns = nouns1.filter(n => nouns2.includes(n));
        if (commonNouns.length >= 2) {
          return 0.7; // High probability of refinement
        }
        if (commonNouns.length >= 1) {
          return 0.4;
        }
      }
    }

    return 0;
  }

  /**
   * Cross-language similarity detection
   */
  calculateCrossLanguageSimilarity(text1, text2) {
    // Simple Spanish-English translations
    const translations = {
      'configurar': 'configure',
      'limpiar': 'clean',
      'arreglar': 'fix',
      'eliminar': 'remove',
      'añadir': 'add',
      'mejorar': 'improve',
      'actualizar': 'update',
      'instalación': 'installation',
      'configuración': 'configuration',
      'notificación': 'notification'
    };

    const words1 = this.extractWords(text1);
    const words2 = this.extractWords(text2);

    let crossLangMatches = 0;

    for (const word1 of words1) {
      for (const word2 of words2) {
        if (translations[word1] === word2 || translations[word2] === word1) {
          crossLangMatches++;
        }
      }
    }

    const maxPossible = Math.min(words1.length, words2.length);
    return maxPossible > 0 ? crossLangMatches / maxPossible : 0;
  }

  /**
   * Extract and normalize words from text
   */
  extractWords(text) {
    return text.toLowerCase()
      .replace(/[^\w\sáéíóúñ]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2);
  }

  /**
   * Get recommendation based on scores
   */
  getRecommendation(finalScore, breakdown) {
    // Strong indicators for same task
    if (breakdown.component >= 0.5 || breakdown.progressive >= 0.5) {
      return {
        action: 'REUSE_TASK',
        confidence: 'HIGH',
        reason: 'Same component/feature or progressive refinement detected'
      };
    }

    // Adjusted thresholds based on analysis
    if (finalScore >= 0.6) {
      return {
        action: 'REUSE_TASK',
        confidence: 'HIGH',
        reason: 'High overall similarity'
      };
    }

    if (finalScore >= 0.4) {
      return {
        action: 'ASK_USER',
        confidence: 'MEDIUM',
        reason: 'Moderate similarity - could be related'
      };
    }

    return {
      action: 'CREATE_NEW',
      confidence: 'HIGH',
      reason: 'Low similarity - appears to be different work'
    };
  }
}

// Export for testing
module.exports = ImprovedSimilarityCalculator;

/*
IMPLEMENTATION NOTES:

1. This improved algorithm addresses:
   - Semantic variations (resize/resizer)
   - Cross-language (Spanish/English)
   - Component detection (same UI element)
   - Progressive refinement patterns

2. Recommended threshold adjustments:
   - >60% → Auto-reuse (was 70%)
   - 40-60% → Ask user (was 50-70%)
   - <40% → New task (was <50%)

3. Special cases handled:
   - High component score overrides low text similarity
   - Progressive refinement pattern triggers reuse
   - Cross-language matching prevents Spanish/English duplicates

4. To implement:
   - Replace calculateSimilarity in database-mcp-standalone.js
   - Add synonym groups as configuration
   - Consider using a proper NLP library for production
*/