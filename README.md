# Medical 3D Viewer for VS Code

ローカルの DICOM CT シリーズと NIfTI-1 ボリュームを VS Code 内で表示する拡張機能です。Axial・Coronal・Sagittal の断面と、WebGL2 を使った 3D ボリュームを表示できます。DICOM CT では、同じ Frame of Reference を参照する RT Structure Set の輪郭も重ねられます。

> **研究・開発用途専用です。診断や治療方針の決定には使用しないでください。**

## インストール

Marketplace で公開された後は、VS Code の拡張機能ビューで「Medical 3D Viewer」を検索してインストールできます。VSIX ファイルを受け取った場合は、拡張機能ビューの「…」メニューから「VSIX からのインストール」を選びます。

デスクトップ版 VS Code と WebGL2 に対応した GPU が必要です。Web 版 VS Code、Remote SSH、Codespaces での動作は対象外です。

## 使い方

### DICOM CT

1. ローカルの `.dcm`、`.dicom`、`.ima` ファイルを VS Code で開くと、そのファイルだけを2D表示します。シリーズ全体の走査は行いません。拡張子の大文字表記にも対応します。
2. シリーズ全体を3D表示する場合は、ステータスバーの「Open CT」またはコマンドパレットの **Medical 3D Viewer: Open DICOM CT Series** を選びます。フォルダーを指定し、候補の CT シリーズを選択してください。拡張子のない DICOM ファイルもこの方法で読み込めます。

2D画面の右側にある **Load series in 3D** ボタンからも、表示中の画像が属するシリーズを3D表示できます。同じフォルダー以下を走査し、シリーズと対応するRT Structure Setを読み込んで、同じタブを3D画面に切り替えます。走査をキャンセルした場合やシリーズが見つからない場合は2D表示を維持します。

単一画像の2D表示では、スクロールで拡大・縮小、ドラッグでパン、**Reset view** で表示位置と倍率をリセットできます。画像にフォーカスすると `+` / `-` で拡大・縮小、`0` でリセットできます。ウィンドウ幅・レベルはDICOM内の値（複数ある場合は先頭）を使用し、有効な値がなければCT軟部組織用の幅400・レベル40を使用します。右側の設定で変更できます。

2D表示には3D再構成用の位置・向きやシリーズ情報は不要です。Pixel Spacingがある場合は実寸の縦横比を反映し、ない場合は正方形の画素として表示します。単一画像の2D表示ではRT Structure Setを読み込みません。ファイルサイズは64 MiB、画像は最大16,384画素／辺・16,777,216画素までです。

### NIfTI

Explorer からローカルの `.nii` または `.nii.gz` ファイルを開きます。拡張子の大文字表記にも対応します。NIfTI はファイル単位で開くため、DICOM 用のフォルダー選択コマンドは使用しません。

### 表示操作

- 断面画像上でスクロールするとスライスが移動し、Ctrl+スクロールで拡大・縮小できます。
- 3D ビューはドラッグで回転し、スクロールで拡大・縮小できます。
- 右側の設定でウィンドウ幅・レベル、表示プリセット、透明度、補間方法、切り出し範囲を調整できます。DICOM CT では ROI の表示も調整できます。
- 画像右上の拡大アイコンで表示領域を広げ、同じアイコンか Esc キーで戻せます。

3D読み込み中は画面上部に％表示と進捗バーを表示します。検証や3D ROIマスク生成など、進捗率が確定しない段階では不定の進捗表示になります。完了・キャンセル・エラー時にはバーを非表示にします。読み込み中は画面右上の **Cancel loading** で中断できます。大きなボリュームでは、画像の読み込みと 3D 表示に時間がかかることがあります。

## 対応データ

### DICOM

- 単一フレームの CT Image Storage、DICOM Part 10 形式
- 非圧縮の Implicit VR Little Endian または Explicit VR Little Endian
- 16 ビットの MONOCHROME2 画像。3D 再構成には Image Position (Patient)、Image Orientation (Patient)、Pixel Spacing が必要です
- CT と同じ Frame of Reference を参照する RT Structure Set の `CLOSED_PLANAR` 輪郭。2D 断面に輪郭線、3D ビューに半透明のボクセルマスクを表示します

圧縮画像、Enhanced CT、CT 以外の DICOM モダリティ、不等間隔・欠損・重複スライスには対応していません。3D で同時表示できる ROI マスクは先頭の 8 件までです。3D マスクは輪郭を最も近い CT スライスのボクセルに塗りつぶした近似表示です。

### NIfTI

- NIfTI-1 の single-file 形式（`.nii`、gzip 圧縮された `.nii.gz`）
- 3 次元のスカラーボリューム
- `uint8`、`int8`、`uint16`、`int16`、`uint32`、`int32`、`float32`、`float64`
- little-endian と big-endian
- `scl_slope` / `scl_inter` による画素値変換
- sform または qform による位置・向き・ボクセル間隔。どちらもない場合は pixdim を使用します

NIfTI-2、pair 形式（`.hdr` / `.img`）、4 次元以上のデータ、複素数・RGB などの非スカラー型、shear を含む affine 変換には対応していません。NIfTI のセグメンテーションやラベルを ROI として解釈する機能もありません。

表示可能なデータ量は、拡張機能の読み込み上限、GPU メモリ、WebGL2 の 3D テクスチャ最大寸法に左右されます。3D 表示や拡大した断面表示は、表示サイズが大きいほど GPU・CPU の負荷が増えます。

## データの取り扱い

DICOM と NIfTI の入力ファイルはローカルで読み取り専用として処理します。この拡張機能に外部送信やテレメトリーの機能はありません。DICOM の患者氏名・ID は画面とログに表示しません。RT Structure Set の **ROI 名は画面に表示されます**。識別情報を含む ROI 名のデータを扱う際は注意してください。

## 開発と検証

このフォルダーを VS Code で開き、`Ctrl+F5` で Extension Development Host を起動できます。デバッグ時は `F5` を使います。追加パッケージやビルドは不要です。

Node.js が利用できる場合は `npm test` で、合成 DICOM・RT Structure Set・ROI マスク・NIfTI を使った解析と幾何検証のテストを実行できます。

要件と受け入れ基準は [REQUIREMENTS.md](REQUIREMENTS.md) を参照してください。Windows・macOS・Linux の 3 OS での実機検証と性能目標の測定は未実施です。
