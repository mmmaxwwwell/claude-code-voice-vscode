#!/usr/bin/env python3
"""Generate a scaffold 'hey_claude' ONNX wake word model.

Creates a valid ONNX model with architecture matching openWakeWord's built-in
models (e.g. alexa_v0.1.onnx):
  - Input:  [1, 16, 96] float32
  - Output: [1, 1]      float32
  - Layers: Flatten -> MatMul -> Add -> Sigmoid

The model has random weights and won't actually detect "hey claude", but it is
structurally valid for pipeline integration and openWakeWord loading.

Usage:
    uv run python scripts/generate_hey_claude_model.py
"""

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "models" / "hey_claude.onnx"

# Match openWakeWord built-in model shapes
INPUT_SHAPE = [1, 16, 96]  # [batch, frames, features]
FLATTEN_DIM = 16 * 96  # 1536
OUTPUT_DIM = 1


def generate_model() -> None:
    """Build and save the scaffold ONNX model."""
    rng = np.random.default_rng(seed=42)

    # Weight initializers (random but deterministic)
    weights = rng.standard_normal((FLATTEN_DIM, OUTPUT_DIM)).astype(np.float32) * 0.01
    bias = np.zeros((OUTPUT_DIM,), dtype=np.float32)

    weights_init = helper.make_tensor("weights", TensorProto.FLOAT, weights.shape, weights.flatten().tolist())
    bias_init = helper.make_tensor("bias", TensorProto.FLOAT, bias.shape, bias.flatten().tolist())

    # Graph nodes: Flatten -> MatMul -> Add -> Sigmoid
    flatten_node = helper.make_node("Flatten", inputs=["input"], outputs=["flat"], axis=1)
    matmul_node = helper.make_node("MatMul", inputs=["flat", "weights"], outputs=["matmul_out"])
    add_node = helper.make_node("Add", inputs=["matmul_out", "bias"], outputs=["add_out"])
    sigmoid_node = helper.make_node("Sigmoid", inputs=["add_out"], outputs=["output"])

    # Input/output tensor specs
    input_tensor = helper.make_tensor_value_info("input", TensorProto.FLOAT, INPUT_SHAPE)
    output_tensor = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, OUTPUT_DIM])

    # Build graph and model
    graph = helper.make_graph(
        nodes=[flatten_node, matmul_node, add_node, sigmoid_node],
        name="hey_claude",
        inputs=[input_tensor],
        outputs=[output_tensor],
        initializer=[weights_init, bias_init],
    )

    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 7

    # Validate before saving
    onnx.checker.check_model(model)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(OUTPUT_PATH))
    print(f"Model saved to {OUTPUT_PATH}")
    print(f"  Input shape:  {INPUT_SHAPE}")
    print(f"  Output shape: [1, {OUTPUT_DIM}]")


if __name__ == "__main__":
    generate_model()
