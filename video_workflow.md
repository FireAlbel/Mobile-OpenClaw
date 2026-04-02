# Coze 工作流操作手册：现实世界与童话世界相互转换

## 工作流概述

本工作流实现现实世界与童话世界之间的相互转换，包括场景分析、风格迁移、人物处理、融合优化和后期特效等完整流程。

## 节点配置

### 节点1：Entry（开始节点）

**节点名称**：Entry

**输入参数**：

```json
{
  "project_name": {
    "type": "string",
    "required": true,
    "description": "项目名称"
  },
  "transformation_type": {
    "type": "string",
    "required": true,
    "enum": ["现实→童话", "童话→现实"],
    "description": "转换方向"
  },
  "scene_image_url": {
    "type": "string",
    "required": true,
    "description": "场景图像URL"
  },
  "character_image_url": {
    "type": "string",
    "required": true,
    "description": "人物图像URL"
  },
  "reference_image_url": {
    "type": "string",
    "required": false,
    "description": "参考图像URL（可选）"
  },
  "target_style": {
    "type": "string",
    "required": true,
    "description": "目标风格描述"
  },
  "mood": {
    "type": "string",
    "required": true,
    "description": "情感氛围"
  },
  "quality_level": {
    "type": "string",
    "required": false,
    "default": "high",
    "description": "质量要求"
  }
}
```

---

### 节点2：scene_analyzer（场景分析）

**节点名称**：scene_analyzer

**提示词**：

```
你是一个专业的场景分析专家，负责分析图像的场景构成、元素特征、光影条件和风格属性。

请详细分析用户提供的场景图像：

1. **场景元素识别**
   - 列出所有可见的环境元素（建筑、植被、天空、地面等）
   - 识别人造物品和自然元素
   - 描述整体环境氛围

2. **构图分析**
   - 主体在画面中的位置
   - 透视类型和视觉引导线
   - 前景、中景、背景的层次分布

3. **光影分析**
   - 主光源方向和类型
   - 阴影特征（方向、长度、软硬）
   - 高光区域和环境光

4. **色彩分析**
   - 主导色相和配色方案
   - 色彩饱和度和明度
   - 色彩和谐度和对比关系

5. **风格特征**
   - 当前风格类型（现实/艺术/卡通）
   - 写实程度和细节水平
   - 适合的风格转换方向

6. **转换建议**
   - 针对目标转换方向（{{transformation_type}}）
   - 需要转换的元素
   - 风格调整建议
   - 优先级排序

请以 JSON 格式输出分析结果，包含以下字段：
- scene_analysis：场景分析详情
- transformation_suggestions：转换建议
```

**输入映射**：

```json
{
  "scene_image_url": "{{inputs.scene_image_url}}",
  "transformation_type": "{{inputs.transformation_type}}",
  "reference_image_url": "{{inputs.reference_image_url}}"
}
```

**输出映射**：

```json
{
  "scene_analysis_result": {
    "type": "object",
    "value": {
      "scene_analysis": {
        "environment": {
          "type": "string",
          "description": "环境类型"
        },
        "elements": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "场景元素列表"
        },
        "atmosphere": {
          "type": "string",
          "description": "整体氛围"
        },
        "composition": {
          "subject_position": {
            "type": "string"
          },
          "perspective": {
            "type": "string"
          },
          "layers": {
            "foreground": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "midground": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "background": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "lighting": {
          "main_light": {
            "direction": {
              "type": "string"
            },
            "type": {
              "type": "string"
            },
            "intensity": {
              "type": "string"
            },
            "color_temp": {
              "type": "string"
            }
          },
          "shadows": {
            "direction": {
              "type": "string"
            },
            "length": {
              "type": "string"
            },
            "hardness": {
              "type": "string"
            }
          }
        },
        "color": {
          "dominant_hue": {
            "type": "string"
          },
          "saturation": {
            "type": "string"
          },
          "brightness": {
            "type": "string"
          },
          "palette": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "style": {
          "current": {
            "type": "string"
          },
          "realism": {
            "type": "string"
          },
          "detail_level": {
            "type": "string"
          }
        }
      },
      "transformation_suggestions": {
        "fairy_tale_elements": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "realistic_elements": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "priority": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

---

### 节点3：style_transfer（风格迁移）

**节点名称**：style_transfer

**提示词**：

```
你是一个专业的风格迁移专家，负责将图像在现实风格和童话风格之间转换。

根据场景分析结果，执行风格迁移：

**输入信息：**
- 场景图像URL：{{scene_image_url}}
- 转换方向：{{transformation_type}}
- 目标风格：{{target_style}}
- 场景分析结果：{{scene_analysis_result}}

**转换要求：**
1. **风格转换**
   - 现实→童话：增加饱和度，使用鲜艳色调，添加童话元素
   - 童话→现实：降低饱和度，使用自然色调，增加真实感细节

2. **元素替换**
   - 识别需要转换的关键元素
   - 进行风格化处理
   - 保持场景结构完整

3. **技术实现**
   - 描述使用的技术方法
   - 配置的参数
   - 生成的版本

请以 JSON 格式输出风格迁移结果，包含以下字段：
- method：使用的方法
- parameters：参数配置
- results：输出结果（包含图像URL列表）
- recommended：推荐版本
- adjustments：调整说明
```

**输入映射**：

```json
{
  "scene_image_url": "{{inputs.scene_image_url}}",
  "transformation_type": "{{inputs.transformation_type}}",
  "target_style": "{{inputs.target_style}}",
  "mood": "{{inputs.mood}}",
  "scene_analysis_result": "{{nodes.scene_analyzer.outputs.scene_analysis_result}}"
}
```

**输出映射**：

```json
{
  "style_transfer_result": {
    "type": "object",
    "value": {
      "input": {
        "original_image_url": {
          "type": "string",
          "description": "原始图像URL"
        },
        "source_style": {
          "type": "string"
        },
        "target_style": {
          "type": "string"
        }
      },
      "method": {
        "primary": {
          "type": "string"
        },
        "secondary": {
          "type": "string"
        },
        "models": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "parameters": {
        "denoising": {
          "type": "number"
        },
        "cfg_scale": {
          "type": "number"
        },
        "steps": {
          "type": "number"
        },
        "sampler": {
          "type": "string"
        }
      },
      "results": {
        "output_image_urls": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "输出图像URL列表"
        },
        "variations": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "recommended_url": {
          "type": "string",
          "description": "推荐版本图像URL"
        }
      },
      "adjustments": {
        "color": {
          "type": "string"
        },
        "lighting": {
          "type": "string"
        },
        "elements": {
          "type": "string"
        }
      }
    }
  }
}
```

---

### 节点4：character_processor（人物处理）

**节点名称**：character_processor

**提示词**：

```
你是一个专业的人物处理专家，负责提取、处理和风格化人物图像。

请处理用户提供的人物图像：

**输入信息：**
- 人物图像URL：{{character_image_url}}
- 转换方向：{{transformation_type}}
- 目标风格：{{target_style}}
- 风格迁移结果：{{style_transfer_result}}

**处理要求：**
1. **人物提取**
   - 提取人物主体
   - 优化边缘细节
   - 处理头发、半透明材质等复杂区域

2. **姿态调整**
   - 分析目标场景的空间关系
   - 调整人物姿态以匹配场景
   - 确保透视关系正确

3. **光影匹配**
   - 分析场景光源
   - 调整人物光影
   - 添加适当的阴影

4. **风格匹配**
   - 调整人物风格以匹配目标场景
   - 统一色彩和质感
   - 确保风格一致性

5. **比例调整**
   - 分析场景比例
   - 调整人物大小
   - 确保与场景协调

请以 JSON 格式输出人物处理结果，包含以下字段：
- extraction：提取结果
- pose：姿态调整
- lighting：光影调整
- style：风格匹配
- proportion：比例调整
- output：输出文件（包含URL）
```

**输入映射**：

```json
{
  "character_image_url": "{{inputs.character_image_url}}",
  "transformation_type": "{{inputs.transformation_type}}",
  "target_style": "{{inputs.target_style}}",
  "style_transfer_result": "{{nodes.style_transfer.outputs.style_transfer_result}}",
  "scene_image_url": "{{nodes.style_transfer.outputs.style_transfer_result.results.recommended_url}}"
}
```

**输出映射**：

```json
{
  "character_processing_result": {
    "type": "object",
    "value": {
      "input": {
        "original_image_url": {
          "type": "string",
          "description": "原始人物图像URL"
        },
        "extraction_method": {
          "type": "string"
        },
        "scene_info": {
          "type": "string"
        }
      },
      "processing": {
        "extraction": {
          "method": {
            "type": "string"
          },
          "quality": {
            "type": "string"
          },
          "edge_quality": {
            "type": "string"
          },
          "transparency": {
            "type": "string"
          }
        },
        "pose": {
          "original_pose": {
            "type": "string"
          },
          "adjusted_pose": {
            "type": "string"
          },
          "adjustment_method": {
            "type": "string"
          }
        },
        "lighting": {
          "scene_light_direction": {
            "type": "string"
          },
          "shadow_added": {
            "type": "boolean"
          },
          "environment_light": {
            "type": "string"
          },
          "reflection_added": {
            "type": "boolean"
          }
        },
        "style": {
          "target_style": {
            "type": "string"
          },
          "adjustments": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "proportion": {
          "scale_ratio": {
            "type": "number"
          },
          "perspective": {
            "type": "string"
          },
          "ground_contact": {
            "type": "string"
          }
        }
      },
      "output": {
        "processed_character_url": {
          "type": "string",
          "description": "处理后的人物图像URL（透明背景PNG）"
        },
        "shadow_layer_url": {
          "type": "string",
          "description": "阴影图层URL"
        },
        "lighting_adjustment_url": {
          "type": "string",
          "description": "光影调整图层URL"
        },
        "quality": {
          "type": "string"
        },
        "ready_for_embedding": {
          "type": "boolean"
        }
      }
    }
  }
}
```

---

### 节点5：fusion_optimizer（融合优化）

**节点名称**：fusion_optimizer

**提示词**：

```
你是一个专业的融合优化专家，负责将处理后的人物自然地嵌入到风格迁移后的场景中。

请执行融合优化：

**输入信息：**
- 风格迁移结果：{{style_transfer_result}}
- 人物处理结果：{{character_processing_result}}
- 目标风格：{{target_style}}
- 情感氛围：{{mood}}

**融合要求：**
1. **边缘融合**
   - 使用图层蒙版和混合模式
   - 确保边缘自然过渡
   - 无明显的拼接痕迹

2. **接触阴影**
   - 添加地面接触阴影
   - 处理环境遮蔽
   - 确保阴影方向正确

3. **色彩统一**
   - 调整色彩平衡
   - 统一饱和度
   - 应用色彩分级

4. **光影统一**
   - 全局光影调整
   - 局部光影优化
   - 确保光源一致性

5. **细节优化**
   - 边缘锐化
   - 噪点匹配
   - 景深效果

请以 JSON 格式输出融合优化结果，包含以下字段：
- layer_structure：图层结构
- edge_blending：边缘融合
- contact_shadows：接触阴影
- color_adjustment：色彩调整
- lighting_adjustment：光影调整
- optimization：细节优化
- output：输出文件（包含URL）
```

**输入映射**：

```json
{
  "style_transfer_result": "{{nodes.style_transfer.outputs.style_transfer_result}}",
  "character_processing_result": "{{nodes.character_processor.outputs.character_processing_result}}",
  "target_style": "{{inputs.target_style}}",
  "mood": "{{inputs.mood}}"
}
```

**输出映射**：

```json
{
  "fusion_optimization_result": {
    "type": "object",
    "value": {
      "input": {
        "scene_image_url": {
          "type": "string",
          "description": "风格迁移后的场景图像URL"
        },
        "character_image_url": {
          "type": "string",
          "description": "处理后的人物图像URL"
        },
        "shadow_layer_url": {
          "type": "string",
          "description": "人物阴影图层URL"
        }
      },
      "fusion": {
        "layer_structure": {
          "type": "string"
        },
        "edge_blending": {
          "method": {
            "type": "string"
          },
          "quality": {
            "type": "string"
          },
          "feather": {
            "type": "string"
          }
        },
        "contact_shadows": {
          "ground_shadow": {
            "type": "boolean"
          },
          "ambient_occlusion": {
            "type": "boolean"
          },
          "projection_shadow": {
            "type": "boolean"
          }
        }
      },
      "adjustments": {
        "color": {
          "color_balance": {
            "type": "string"
          },
          "saturation": {
            "type": "string"
          },
          "color_grading": {
            "type": "string"
          }
        },
        "lighting": {
          "global_adjustment": {
            "type": "string"
          },
          "local_optimization": {
            "type": "string"
          },
          "ambient_occlusion": {
            "type": "string"
          }
        }
      },
      "optimization": {
        "sharpening": {
          "type": "string"
        },
        "noise_matching": {
          "type": "string"
        },
        "depth_of_field": {
          "type": "string"
        }
      },
      "output": {
        "final_image_url": {
          "type": "string",
          "description": "最终合成图像URL"
        },
        "psd_file_url": {
          "type": "string",
          "description": "PSD源文件URL"
        },
        "quality": {
          "type": "string"
        },
        "harmony": {
          "type": "string"
        }
      }
    }
  }
}
```

---

### 节点6：post_effects（后期特效）

**节点名称**：post_effects

**提示词**：

```
你是一个专业的后期特效专家，负责为合成图像添加整体氛围特效和艺术增强。

请添加后期特效：

**输入信息：**
- 融合优化结果：{{fusion_optimization_result}}
- 转换方向：{{transformation_type}}
- 目标风格：{{target_style}}
- 情感氛围：{{mood}}

**特效要求：**
1. **光效添加**
   - 环境光效
   - 魔法粒子（童话风格）
   - 真实光影（现实风格）
   - 发光效果

2. **粒子系统**
   - 自然粒子（花瓣、雪花等）
   - 魔法粒子（星尘、能量等）
   - 氛围粒子（雾气、尘埃等）

3. **色彩分级**
   - 选择合适的分级风格
   - 调整饱和度和对比度
   - 应用色彩查找表（LUT）

4. **艺术增强**
   - 边缘锐化
   - 纹理叠加
   - 暗角效果
   - 光斑效果

请以 JSON 格式输出后期特效结果，包含以下字段：
- lighting_effects：光效添加
- particle_systems：粒子系统
- color_grading：色彩分级
- artistic_enhancement：艺术增强
- output：最终输出（包含URL）
```

**输入映射**：

```json
{
  "fusion_optimization_result": "{{nodes.fusion_optimizer.outputs.fusion_optimization_result}}",
  "transformation_type": "{{inputs.transformation_type}}",
  "target_style": "{{inputs.target_style}}",
  "mood": "{{inputs.mood}}"
}
```

**输出映射**：

```json
{
  "post_effects_result": {
    "type": "object",
    "value": {
      "input": {
        "final_image_url": {
          "type": "string",
          "description": "融合后的图像URL"
        },
        "style": {
          "type": "string"
        },
        "mood": {
          "type": "string"
        }
      },
      "effects": {
        "lighting": {
          "ambient_glow": {
            "type": {
              "type": "string"
            },
            "intensity": {
              "type": "string"
            },
            "color": {
              "type": "string"
            }
          },
          "magic_particles": {
            "type": {
              "type": "string"
            },
            "count": {
              "type": "string"
            },
            "colors": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "light_beams": {
            "type": {
              "type": "string"
            },
            "count": {
              "type": "string"
            },
            "intensity": {
              "type": "string"
            }
          }
        },
        "particles": {
          "petals": {
            "type": {
              "type": "string"
            },
            "count": {
              "type": "string"
            },
            "motion": {
              "type": "string"
            }
          },
          "fireflies": {
            "type": {
              "type": "string"
            },
            "count": {
              "type": "string"
            },
            "animation": {
              "type": "string"
            }
          }
        },
        "color_grading": {
          "style": {
            "type": "string"
          },
          "saturation": {
            "type": "string"
          },
          "contrast": {
            "type": "string"
          },
          "shadows": {
            "type": "string"
          },
          "highlights": {
            "type": "string"
          },
          "lut": {
            "type": "string"
          }
        },
        "artistic": {
          "sharpening": {
            "type": "string"
          },
          "texture": {
            "type": "string"
          },
          "vignette": {
            "type": "string"
          },
          "bokeh": {
            "type": "string"
          }
        }
      },
      "output": {
        "final_image_url": {
          "type": "string",
          "description": "带特效的最终图像URL"
        },
        "psd_file_url": {
          "type": "string",
          "description": "完整PSD源文件URL"
        },
        "effect_layers": {
          "type": "string"
        },
        "quality": {
          "type": "string"
        },
        "atmosphere": {
          "type": "string"
        },
        "process_report": {
          "type": "string",
          "description": "处理报告"
        },
        "source_files": {
          "type": "object",
          "value": {
            "psd_url": {
              "type": "string"
            },
            "layers_description": {
              "type": "string"
            }
          }
        }
      }
    }
  }
}
```

---

### 节点7：Exit（结束节点）

**节点名称**：Exit

**输入映射**：

```json
{
  "final_image_url": "{{nodes.post_effects.outputs.post_effects_result.output.final_image_url}}",
  "process_report": "{{nodes.post_effects.outputs.post_effects_result.output.process_report}}",
  "quality": "{{nodes.post_effects.outputs.post_effects_result.output.quality}}",
  "source_files": "{{nodes.post_effects.outputs.post_effects_result.output.source_files}}",
  "project_name": "{{inputs.project_name}}",
  "transformation_type": "{{inputs.transformation_type}}"
}
```

**输出映射**：

```json
{
  "final_image_url": {
    "type": "string",
    "description": "最终图像URL"
  },
  "process_report": {
    "type": "string",
    "description": "处理报告"
  },
  "quality": {
    "type": "string",
    "description": "质量评估"
  },
  "source_files": {
    "type": "object",
    "description": "源文件信息"
  },
  "project_name": {
    "type": "string",
    "description": "项目名称"
  },
  "transformation_type": {
    "type": "string",
    "description": "转换方向"
  }
}
```

## 节点连接关系

```
Entry → scene_analyzer → style_transfer → character_processor → fusion_optimizer → post_effects → Exit
```

## 输入映射语法说明

### 引用工作流输入

```
{{inputs.参数名}}
```

### 引用节点输出

```
{{nodes.节点名称.outputs.输出变量名}}
```

### 引用输出对象的特定字段

```
{{nodes.节点名称.outputs.输出变量名.字段名}}
```

## 工作流执行流程

1. **用户输入**：通过Entry节点接收用户输入
2. **场景分析**：scene_analyzer分析场景图像
3. **风格迁移**：style_transfer执行风格转换
4. **人物处理**：character_processor处理人物图像
5. **融合优化**：fusion_optimizer将人物嵌入场景
6. **后期特效**：post_effects添加最终特效
7. **输出结果**：Exit节点返回最终结果

## 文件类型处理说明

由于Coze工作流不支持直接输出文件类型，所有图像文件均使用URL字符串类型：

- **输入**：使用`_url`后缀的字符串参数（如`scene_image_url`）
- **输出**：在输出对象中包含`_url`后缀的字段（如`final_image_url`）
- **存储**：建议使用云存储服务（如AWS S3、阿里云OSS）存储文件
- **访问**：下游节点通过URL访问文件

## 测试参数示例

```json
{
  "project_name": "测试项目",
  "transformation_type": "现实→童话",
  "scene_image_url": "https://example.com/scene.jpg",
  "character_image_url": "https://example.com/person.jpg",
  "reference_image_url": "https://example.com/reference.jpg",
  "target_style": "迪士尼童话风格",
  "mood": "温馨梦幻",
  "quality_level": "high"
}
```

## 预期输出示例

```json
{
  "final_image_url": "https://example.com/final_with_effects.jpg",
  "process_report": "场景分析完成 → 风格迁移完成 → 人物处理完成 → 融合优化完成 → 后期特效完成",
  "quality": "优秀",
  "source_files": {
    "psd_url": "https://example.com/final_with_effects.psd",
    "layers_description": "包含所有特效图层的完整PSD文件"
  },
  "project_name": "测试项目",
  "transformation_type": "现实→童话"
}
```
