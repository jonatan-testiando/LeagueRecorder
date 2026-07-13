"""Fase 2: entrena el CLASIFICADOR TEMPORAL de clics (verificador).

Dado un stack (T,64,64,3) alrededor de un candidato de clic, decide clic-real (1)
vs falso-positivo (0) mirando la ANIMACIÓN. Los T frames se apilan como canales
(T*3) y una CNN 2D pequeña los mezcla desde la primera capa.

Split por PARTIDA (no por muestra) para medir generalización real a VODs nuevos.
Exporta ONNX (input float32 [N, T*3, 64, 64] normalizado /255, output prob sigmoide).

Uso: python train_click_verifier.py <ds.npz> [--out models/click_verifier.onnx]
                                    [--epochs 40] [--val-frac 0.2] [--bs 128]
"""

import os
import sys
import json
import numpy as np


def _arg(flag, default, cast=str):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    import torch
    import torch.nn as nn
    torch.manual_seed(0)

    ds_path = sys.argv[1]
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.abspath(_arg("--out", os.path.join(repo, "models", "click_verifier.onnx")))
    epochs = _arg("--epochs", 40, int)
    val_frac = _arg("--val-frac", 0.2, float)
    bs = _arg("--bs", 128, int)
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    d = np.load(ds_path, allow_pickle=True)
    X = d["X"]                        # (N,T,64,64,3) uint8 BGR
    y = d["y"].astype(np.float32)
    meta = json.loads(str(d["meta"]))
    N, T, S, _, _ = X.shape
    C = T * 3
    # (N,T,H,W,3) -> (N, T*3, H, W)
    Xc = np.transpose(X, (0, 1, 4, 2, 3)).reshape(N, C, S, S).astype(np.float32) / 255.0

    # split por partida
    matches = sorted(set(m["match"] for m in meta))
    rng = np.random.RandomState(0)
    rng.shuffle(matches)
    n_val = max(1, int(len(matches) * val_frac))
    val_m = set(matches[:n_val])
    is_val = np.array([m["match"] in val_m for m in meta])
    print(f"partidas={len(matches)} val={sorted(val_m)}  train={int((~is_val).sum())} val={int(is_val.sum())}")
    print(f"balance: pos={int((y==1).sum())} neg={int((y==0).sum())}")

    Xtr, ytr = torch.tensor(Xc[~is_val]), torch.tensor(y[~is_val])
    Xva, yva = torch.tensor(Xc[is_val]).to(dev), torch.tensor(y[is_val]).to(dev)

    class Net(nn.Module):
        def __init__(self, cin):
            super().__init__()
            self.f = nn.Sequential(
                nn.Conv2d(cin, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.AdaptiveAvgPool2d(1))
            self.head = nn.Linear(64, 1)

        def forward(self, x):
            return self.head(self.f(x).flatten(1)).squeeze(1)

    net = Net(C).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    lossf = nn.BCEWithLogitsLoss()
    ntr = len(ytr)

    def augment(xb):
        # flip horizontal aleatorio por muestra (el anillo es ~simétrico)
        if torch.rand(1).item() < 0.5:
            xb = torch.flip(xb, dims=[3])
        # jitter de brillo
        xb = torch.clamp(xb * (0.85 + 0.3 * torch.rand(1, device=xb.device)), 0, 1)
        return xb

    best = None
    for ep in range(epochs):
        net.train()
        perm = torch.randperm(ntr)
        tot = 0.0
        for i in range(0, ntr, bs):
            idx = perm[i:i + bs]
            xb = augment(Xtr[idx].to(dev)); yb = ytr[idx].to(dev)
            opt.zero_grad()
            loss = lossf(net(xb), yb)
            loss.backward(); opt.step()
            tot += loss.item() * len(idx)
        # val
        net.eval()
        with torch.no_grad():
            pv = torch.sigmoid(net(Xva))
            pred = (pv > 0.5).float()
            tp = ((pred == 1) & (yva == 1)).sum().item()
            fp = ((pred == 1) & (yva == 0)).sum().item()
            fn = ((pred == 0) & (yva == 1)).sum().item()
            prec = tp / (tp + fp) if tp + fp else 0
            rec = tp / (tp + fn) if tp + fn else 0
            f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0
            acc = (pred == yva).float().mean().item()
        if best is None or f1 > best[0]:
            best = (f1, ep, {k: v.detach().cpu().clone() for k, v in net.state_dict().items()})
        if ep % 5 == 0 or ep == epochs - 1:
            print(f"ep{ep:2d} loss={tot/ntr:.3f} val: acc={acc:.3f} P={prec:.3f} R={rec:.3f} F1={f1:.3f}")

    print(f"\nMEJOR val F1={best[0]:.3f} (ep{best[1]})")
    net.load_state_dict(best[2])
    net.eval()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    torch.save(net.state_dict(), os.path.splitext(out)[0] + ".pt")   # respaldo de pesos
    dummy = torch.zeros(1, C, S, S, device=dev)
    try:
        torch.onnx.export(net, dummy, out, input_names=["stack"], output_names=["logit"],
                          dynamic_axes={"stack": {0: "n"}, "logit": {0: "n"}},
                          opset_version=17, dynamo=False)
    except TypeError:
        torch.onnx.export(net, dummy, out, input_names=["stack"], output_names=["logit"],
                          dynamic_axes={"stack": {0: "n"}, "logit": {0: "n"}}, opset_version=17)
    print(f"ONNX -> {out}  (input [n,{C},{S},{S}], T={T})")
    print(json.dumps({"onnx": out, "val_f1": best[0], "C": C, "T": T, "size": S}))


if __name__ == "__main__":
    main()
