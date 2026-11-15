#!/bin/bash
# usage: tour.sh <sheetname> t0 t1 ... (tour seconds)
name=$1; shift; args=(); for t in "$@"; do args+=("t$t=tt=$t"); done
/home/admin/Documents/ProcGenScenes/tools/sheet.sh $name "${args[@]}"
