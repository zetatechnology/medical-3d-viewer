# DICOM 3D Viewer for VS Code

ローカルの CT DICOM シリーズを VS Code 内で表示する拡張機能です。Axial・Coronal・Sagittal の断面と、WebGL2 を使った 3D ボリュームを表示できます。同じ Frame of Reference を参照する RT Structure Set の輪郭も重ねられます。

> **研究・開発用途専用です。診断や治療方針の決定には使用しないでください。**

## インストール

Marketplace で公開された後は、VS Code の拡張機能ビューで「DICOM 3D Viewer」を検索してインストールできます。VSIX ファイルを受け取った場合は、拡張機能ビューの「…」メニューから「VSIX からのインストール」を選びます。

デスクトップ版 VS Code と WebGL2 に対応した GPU が必要です。Web 版 VS Code、Remote SSH、Codespaces での動作は対象外です。

## 使い方

1. ローカルの `.dcm`、`.dicom`、`.ima` ファイルを VS Code で開きます。同じフォルダー以下を走査し、そのファイルが属する CT シリーズを読み込みます。拡張子の大文字表記にも対応します。
2. 拡張子のない DICOM ファイルを使う場合や、フォルダーからシリーズを選ぶ場合は、ステータスバーの「Open CT」またはコマンドパレットの **DICOM: Open CT Series** を選びます。フォルダーを指定し、候補の CT シリーズを選択してください。
3. 断面画像上でスクロールするとスライスが移動します。Ctrl+スクロールで断面を拡大・縮小できます。3D ビューはドラッグで回転し、スクロールで拡大・縮小できます。
4. 右側の設定でウィンドウ幅・レベル、表示プリセット、透明度、3D CT の補間方法、切り出し範囲、ROI の表示を調整できます。画像右上の拡大アイコンで表示領域を広げ、同じアイコンか Esc キーで戻せます。

読み込み中は画面右上の **Cancel loading** で中断できます。大きなシリーズでは、画像の読み込みと 3D 表示に時間がかかることがあります。

## 対応データ

- 単一フレームの CT Image Storage、DICOM Part 10 形式
- 非圧縮の Implicit VR Little Endian または Explicit VR Little Endian
- 16 ビットの MONOCHROME2 画像。3D 再構成には Image Position (Patient)、Image Orientation (Patient)、Pixel Spacing が必要です
- CT と同じ Frame of Reference を参照する RT Structure Set の `CLOSED_PLANAR` 輪郭。2D 断面に輪郭線、3D ビューに半透明のボクセルマスクを表示します

圧縮画像、Enhanced CT、CT 以外のモダリティ、不等間隔・欠損・重複スライスには対応していません。3D で同時表示できる ROI マスクは先頭の 8 件までです。3D マスクは輪郭を最も近い CT スライスのボクセルに塗りつぶした近似表示です。

表示可能なデータ量は GPU メモリと WebGL2 の 3D テクスチャ最大寸法に左右されます。3D 表示や拡大した断面表示は、表示サイズが大きいほど GPU・CPU の負荷が増えます。

## データの取り扱い

DICOM ファイルはローカルで読み取り専用として処理します。この拡張機能に外部送信やテレメトリーの機能はありません。患者氏名・ID は画面とログに表示しません。RT Structure Set の **ROI 名は画面に表示されます**。識別情報を含む ROI 名のデータを扱う際は注意してください。

## 開発と検証

このフォルダーを VS Code で開き、`Ctrl+F5` で Extension Development Host を起動できます。デバッグ時は `F5` を使います。追加パッケージやビルドは不要です。

Node.js が利用できる場合は `npm test` で合成 DICOM を使った解析・幾何検証テストを実行できます。VS Code に付属する Node ランタイムを使う場合は、`ELECTRON_RUN_AS_NODE=1` を設定して Node の `--test` オプションに `test/dicom.test.js`、`test/rtstruct.test.js`、`test/roi-mask.test.js` を渡してください。

要件と受け入れ基準は [REQUIREMENTS.md](REQUIREMENTS.md) を参照してください。Windows・macOS・Linux の 3 OS での実機検証と性能目標の測定は未実施です。
